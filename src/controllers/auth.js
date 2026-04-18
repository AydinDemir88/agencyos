const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const pool       = require('../config/db');
const { writeAudit } = require('../utils/audit');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ACCESS_TOKEN_EXPIRES      = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const REFRESH_TOKEN_EXPIRES_DAYS = parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS || '7', 10);
const MAX_FAILED_ATTEMPTS       = 5;
const LOCKOUT_MINUTES           = 15;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex of raw refresh token — what is stored in DB */
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Cryptographically random 40-byte hex string for refresh token */
function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex');
}

/** Sign a short-lived JWT access token */
function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES, issuer: 'agencyos' }
  );
}

/** httpOnly cookie options for the refresh token */
const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
  path: '/auth',  // restrict cookie to auth routes only
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
async function login(req, res) {
  const { email, password } = req.body;
  const ip = req.ip;
  const ua = req.headers['user-agent'] || null;
  const auditCtx = { resourceType: 'user', ipAddress: ip, userAgent: ua };

  // 1. Look up user
  let user;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, password_hash, role, status,
              failed_login_count, locked_until
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [email]
    );
    user = rows[0];
  } catch (err) {
    console.error('[AUTH] DB error on login lookup:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // 2. User not found — return same message as wrong password (prevents user enumeration)
  if (!user) {
    await writeAudit({ ...auditCtx, action: 'USER_LOGIN', result: 'failure', payload: { reason: 'user_not_found' } });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // 3. Lockout check
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const retryAfterSeconds = Math.ceil((new Date(user.locked_until) - Date.now()) / 1000);
    await writeAudit({ ...auditCtx, userId: user.id, action: 'USER_LOGIN', result: 'failure', payload: { reason: 'account_locked' } });
    return res.status(429).json({
      error: 'Account temporarily locked due to too many failed attempts',
      retry_after_seconds: retryAfterSeconds,
    });
  }

  // 4. Status check
  if (user.status !== 'active') {
    await writeAudit({ ...auditCtx, userId: user.id, action: 'USER_LOGIN', result: 'failure', payload: { reason: 'account_inactive', status: user.status } });
    return res.status(403).json({ error: 'Account is not active' });
  }

  // 5. Password verification
  const passwordValid = await bcrypt.compare(password, user.password_hash);

  if (!passwordValid) {
    const newCount  = (user.failed_login_count || 0) + 1;
    const shouldLock = newCount >= MAX_FAILED_ATTEMPTS;
    const lockedUntil = shouldLock
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
      : null;

    await pool.query(
      `UPDATE users
       SET failed_login_count = $1,
           locked_until       = $2,
           updated_at         = NOW()
       WHERE id = $3`,
      [newCount, lockedUntil, user.id]
    );

    await writeAudit({
      ...auditCtx,
      userId: user.id,
      action: 'USER_LOGIN',
      result: 'failure',
      payload: { reason: 'wrong_password', attempt: newCount, locked: shouldLock },
    });

    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // 6. Success — reset lockout counters and record last login
  await pool.query(
    `UPDATE users
     SET failed_login_count = 0,
         locked_until       = NULL,
         last_login_at      = NOW(),
         updated_at         = NOW()
     WHERE id = $1`,
    [user.id]
  );

  // 7. Issue access token + refresh token
  const accessToken    = signAccessToken(user);
  const rawRefresh     = generateRefreshToken();
  const tokenHash      = hashToken(rawRefresh);
  const refreshExpiry  = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, tokenHash, refreshExpiry, ip, ua]
  );

  await writeAudit({ ...auditCtx, userId: user.id, action: 'USER_LOGIN', result: 'success', resourceId: user.id });

  res.cookie('refresh_token', rawRefresh, refreshCookieOptions());

  return res.status(200).json({
    access_token : accessToken,
    token_type   : 'Bearer',
    expires_in   : 900,   // 15 minutes in seconds
    user: {
      id    : user.id,
      name  : user.name,
      email : user.email,
      role  : user.role,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------
async function refresh(req, res) {
  const rawToken = req.cookies?.refresh_token;
  const ip = req.ip;
  const ua = req.headers['user-agent'] || null;

  if (!rawToken) {
    return res.status(401).json({ error: 'No refresh token provided' });
  }

  const tokenHash = hashToken(rawToken);

  let row;
  try {
    const { rows } = await pool.query(
      `SELECT rt.id,
              rt.user_id,
              rt.expires_at,
              rt.revoked,
              u.id     AS uid,
              u.name,
              u.email,
              u.role,
              u.status
       FROM   refresh_tokens rt
       JOIN   users u ON u.id = rt.user_id
       WHERE  rt.token_hash = $1
       LIMIT  1`,
      [tokenHash]
    );
    row = rows[0];
  } catch (err) {
    console.error('[AUTH] DB error on token refresh:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // Token not found
  if (!row) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }

  // Token reuse detected — revoke all sessions for this user (possible theft)
  if (row.revoked) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE user_id = $1`,
      [row.user_id]
    );
    await writeAudit({
      userId     : row.user_id,
      action     : 'REFRESH_TOKEN_REUSE_DETECTED',
      result     : 'failure',
      ipAddress  : ip,
      userAgent  : ua,
      resourceType: 'refresh_token',
    });
    res.clearCookie('refresh_token', { path: '/auth' });
    return res.status(401).json({ error: 'Token reuse detected. All sessions invalidated.' });
  }

  // Token expired
  if (new Date(row.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Refresh token expired', code: 'REFRESH_EXPIRED' });
  }

  // User no longer active
  if (row.status !== 'active') {
    return res.status(403).json({ error: 'Account is not active' });
  }

  // Rotate: revoke old token
  await pool.query(
    `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE id = $1`,
    [row.id]
  );

  // Issue new pair
  const newRaw      = generateRefreshToken();
  const newHash     = hashToken(newRaw);
  const newExpiry   = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [row.user_id, newHash, newExpiry, ip, ua]
  );

  const user = { id: row.uid, name: row.name, email: row.email, role: row.role };
  const accessToken = signAccessToken(user);

  await writeAudit({
    userId     : user.id,
    action     : 'TOKEN_REFRESH',
    result     : 'success',
    ipAddress  : ip,
    userAgent  : ua,
    resourceType: 'refresh_token',
  });

  res.cookie('refresh_token', newRaw, refreshCookieOptions());

  return res.status(200).json({
    access_token : accessToken,
    token_type   : 'Bearer',
    expires_in   : 900,
  });
}

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------
async function logout(req, res) {
  const rawToken = req.cookies?.refresh_token;
  const ip = req.ip;
  const ua = req.headers['user-agent'] || null;

  if (rawToken) {
    const tokenHash = hashToken(rawToken);
    const { rows } = await pool.query(
      `UPDATE refresh_tokens
       SET revoked = true, revoked_at = NOW()
       WHERE token_hash = $1
       RETURNING user_id`,
      [tokenHash]
    );
    const userId = rows[0]?.user_id || null;
    await writeAudit({ userId, action: 'USER_LOGOUT', result: 'success', ipAddress: ip, userAgent: ua });
  }

  res.clearCookie('refresh_token', { path: '/auth' });
  return res.status(200).json({ message: 'Logged out successfully' });
}

module.exports = { login, refresh, logout };
