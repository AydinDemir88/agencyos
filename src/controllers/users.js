const bcrypt         = require('bcrypt');
const pool           = require('../config/db');
const { writeAudit } = require('../utils/audit');

const BCRYPT_COST = parseInt(process.env.BCRYPT_COST || '12', 10);

// ---------------------------------------------------------------------------
// Safe columns returned to callers — password_hash is NEVER included
// ---------------------------------------------------------------------------
const PUBLIC_COLUMNS = `
  id, name, email, role, status,
  last_login_at, failed_login_count, locked_until,
  created_by, created_at, updated_at
`;

// ---------------------------------------------------------------------------
// GET /users
// ---------------------------------------------------------------------------
async function listUsers(req, res) {
  const { page, limit, role, status, search } = req.query;
  const offset = (page - 1) * limit;

  // Build WHERE clauses dynamically with parameterized values
  const conditions = [];
  const values     = [];

  if (role) {
    values.push(role);
    conditions.push(`u.role = $${values.length}`);
  }

  if (status) {
    values.push(status);
    conditions.push(`u.status = $${values.length}`);
  }

  if (search) {
    // Trigram similarity search on name and email
    values.push(`%${search}%`);
    conditions.push(`(u.name ILIKE $${values.length} OR u.email ILIKE $${values.length})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count query (same filters, no pagination)
  const countValues = [...values];
  const countQuery  = `SELECT COUNT(*) FROM users u ${where}`;

  // Data query
  values.push(limit, offset);
  const dataQuery = `
    SELECT ${PUBLIC_COLUMNS}
    FROM   users u
    ${where}
    ORDER  BY u.created_at DESC
    LIMIT  $${values.length - 1}
    OFFSET $${values.length}
  `;

  try {
    const [countResult, dataResult] = await Promise.all([
      pool.query(countQuery, countValues),
      pool.query(dataQuery,  values),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);

    return res.status(200).json({
      data: dataResult.rows,
      meta: {
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[USERS] listUsers error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// POST /users
// ---------------------------------------------------------------------------
async function createUser(req, res) {
  const { name, email, password, role } = req.body;
  const caller = req.user;
  const ip     = req.ip;
  const ua     = req.headers['user-agent'] || null;

  // Only SUPER_ADMIN may create another SUPER_ADMIN
  if (role === 'SUPER_ADMIN' && caller.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only SUPER_ADMIN can assign the SUPER_ADMIN role' });
  }

  // ADMIN cannot create another ADMIN — only SUPER_ADMIN can
  if (role === 'ADMIN' && caller.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only SUPER_ADMIN can create ADMIN users' });
  }

  // Check email uniqueness before hashing (fail fast)
  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [email]
    );
    if (rows.length > 0) {
      return res.status(409).json({ error: 'Email already in use' });
    }
  } catch (err) {
    console.error('[USERS] createUser email check error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  let newUser;
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PUBLIC_COLUMNS}`,
      [name, email, passwordHash, role, caller.id]
    );
    newUser = rows[0];
  } catch (err) {
    console.error('[USERS] createUser insert error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  await writeAudit({
    userId       : caller.id,
    action       : 'USER_CREATE',
    resourceType : 'user',
    resourceId   : newUser.id,
    ipAddress    : ip,
    userAgent    : ua,
    payload      : { name, email, role },
    result       : 'success',
  });

  return res.status(201).json({ data: newUser });
}

// ---------------------------------------------------------------------------
// PATCH /users/:id
// ---------------------------------------------------------------------------
async function updateUser(req, res) {
  const targetId = req.params.id;
  const caller   = req.user;
  const ip       = req.ip;
  const ua       = req.headers['user-agent'] || null;
  const updates  = req.body; // already validated: { name?, role?, status? }

  // Fetch target user
  let target;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, status FROM users WHERE id = $1 LIMIT 1`,
      [targetId]
    );
    target = rows[0];
  } catch (err) {
    console.error('[USERS] updateUser fetch error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }

  // ADMIN cannot modify a SUPER_ADMIN
  if (target.role === 'SUPER_ADMIN' && caller.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Insufficient permissions to modify a SUPER_ADMIN' });
  }

  // Only SUPER_ADMIN can assign SUPER_ADMIN role
  if (updates.role === 'SUPER_ADMIN' && caller.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only SUPER_ADMIN can assign the SUPER_ADMIN role' });
  }

  // Only SUPER_ADMIN can assign ADMIN role
  if (updates.role === 'ADMIN' && caller.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only SUPER_ADMIN can assign the ADMIN role' });
  }

  // A user cannot change their own role (prevents privilege escalation)
  if (updates.role && targetId === caller.id) {
    return res.status(403).json({ error: 'You cannot change your own role' });
  }

  // Build SET clause dynamically — only update provided fields
  const setClauses = [];
  const values     = [];

  if (updates.name !== undefined) {
    values.push(updates.name);
    setClauses.push(`name = $${values.length}`);
  }
  if (updates.role !== undefined) {
    values.push(updates.role);
    setClauses.push(`role = $${values.length}`);
  }
  if (updates.status !== undefined) {
    values.push(updates.status);
    setClauses.push(`status = $${values.length}`);
  }

  values.push(targetId);
  const idPlaceholder = `$${values.length}`;

  let updated;
  try {
    const { rows } = await pool.query(
      `UPDATE users
       SET    ${setClauses.join(', ')}, updated_at = NOW()
       WHERE  id = ${idPlaceholder}
       RETURNING ${PUBLIC_COLUMNS}`,
      values
    );
    updated = rows[0];
  } catch (err) {
    console.error('[USERS] updateUser update error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  await writeAudit({
    userId       : caller.id,
    action       : 'USER_UPDATE',
    resourceType : 'user',
    resourceId   : targetId,
    ipAddress    : ip,
    userAgent    : ua,
    payload      : updates,
    result       : 'success',
  });

  return res.status(200).json({ data: updated });
}

// ---------------------------------------------------------------------------
// DELETE /users/:id  (soft-delete)
// ---------------------------------------------------------------------------
async function deleteUser(req, res) {
  const targetId = req.params.id;
  const caller   = req.user;
  const ip       = req.ip;
  const ua       = req.headers['user-agent'] || null;

  // Cannot delete yourself
  if (targetId === caller.id) {
    return res.status(403).json({ error: 'You cannot deactivate your own account' });
  }

  // Fetch target
  let target;
  try {
    const { rows } = await pool.query(
      `SELECT id, role, status FROM users WHERE id = $1 LIMIT 1`,
      [targetId]
    );
    target = rows[0];
  } catch (err) {
    console.error('[USERS] deleteUser fetch error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Cannot soft-delete a SUPER_ADMIN
  if (target.role === 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'SUPER_ADMIN accounts cannot be deactivated' });
  }

  // ADMIN cannot deactivate another ADMIN
  if (target.role === 'ADMIN' && caller.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only SUPER_ADMIN can deactivate ADMIN accounts' });
  }

  // Already inactive — idempotent response
  if (target.status === 'inactive') {
    return res.status(200).json({ message: 'User is already inactive' });
  }

  try {
    await pool.query(
      `UPDATE users SET status = 'inactive', updated_at = NOW() WHERE id = $1`,
      [targetId]
    );
  } catch (err) {
    console.error('[USERS] deleteUser update error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // Revoke all active refresh tokens for the deactivated user
  try {
    await pool.query(
      `UPDATE refresh_tokens
       SET revoked = true, revoked_at = NOW()
       WHERE user_id = $1 AND revoked = false`,
      [targetId]
    );
  } catch (err) {
    // Non-fatal — log but don't fail the response
    console.error('[USERS] deleteUser token revocation error:', err.message);
  }

  await writeAudit({
    userId       : caller.id,
    action       : 'USER_DEACTIVATE',
    resourceType : 'user',
    resourceId   : targetId,
    ipAddress    : ip,
    userAgent    : ua,
    result       : 'success',
  });

  return res.status(200).json({ message: 'User deactivated successfully' });
}

module.exports = { listUsers, createUser, updateUser, deleteUser };
