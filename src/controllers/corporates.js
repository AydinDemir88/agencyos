const pool                               = require('../config/db');
const { writeAudit }                     = require('../utils/audit');
const { encrypt, decrypt, encryptIfProvided } = require('../utils/crypto');

// ---------------------------------------------------------------------------
// Column sets
// ---------------------------------------------------------------------------
const CORPORATE_PUBLIC_COLS = `
  id, name, tax_id, sector, employee_count,
  contact_email, contact_phone, address, coordinator_name,
  contract_start, contract_end,
  service_fee_type, service_fee_amount,
  credit_limit, credit_used, currency, payment_term_days,
  status, notes, created_by, created_at, updated_at
`;

// Core columns that always exist
const EMPLOYEE_CORE_COLS = `
  id, corporate_id, name, title, department,
  email, phone, cabin_tier, status, created_at
`;
// Full columns after migration
const EMPLOYEE_PUBLIC_COLS = `
  id, corporate_id, name, title, department,
  email, phone, employee_number, cost_center, nationality, date_of_birth,
  cabin_tier, frequent_flyers, preferences, status, created_at
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace passport_enc / iv_passport with a boolean presence flag */
function toPublicEmployee(row) {
  return {
    id              : row.id,
    corporate_id    : row.corporate_id,
    name            : row.name,
    title           : row.title,
    department      : row.department,
    email           : row.email,
    phone           : row.phone,
    employee_number : row.employee_number,
    cost_center     : row.cost_center,
    nationality     : row.nationality,
    date_of_birth   : row.date_of_birth,
    cabin_tier      : row.cabin_tier,
    frequent_flyers : row.frequent_flyers || [],
    preferences     : row.preferences    || {},
    status          : row.status,
    created_at      : row.created_at,
    has_passport    : !!(row.passport_enc),
  };
}

async function assertCorporateExists(id, res) {
  const { rows } = await pool.query(
    'SELECT id FROM corporates WHERE id = $1 LIMIT 1',
    [id]
  );
  if (!rows[0]) {
    res.status(404).json({ error: 'Corporate not found' });
    return false;
  }
  return true;
}

// =============================================================================
// CORPORATES CRUD
// =============================================================================

// ---------------------------------------------------------------------------
// GET /corporates
// ---------------------------------------------------------------------------
async function listCorporates(req, res) {
  const { page = 1, limit = 20, status, search } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  const conditions = [];
  const values     = [];

  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(name ILIKE $${values.length} OR tax_id ILIKE $${values.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countValues = [...values];
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM corporates ${where}`, countValues),
      pool.query(
        `SELECT ${CORPORATE_PUBLIC_COLS}
         FROM   corporates
         ${where}
         ORDER  BY name ASC
         LIMIT  $${values.length + 1}
         OFFSET $${values.length + 2}`,
        [...values, Number(limit), offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);
    return res.status(200).json({
      data: dataResult.rows,
      meta: { total, page: Number(page), limit: Number(limit), total_pages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error('[CORP] listCorporates error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// GET /corporates/:id
// ---------------------------------------------------------------------------
async function getCorporate(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT ${CORPORATE_PUBLIC_COLS} FROM corporates WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Corporate not found' });
    return res.status(200).json({ data: rows[0] });
  } catch (err) {
    console.error('[CORP] getCorporate error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// POST /corporates
// ---------------------------------------------------------------------------
async function createCorporate(req, res) {
  const caller = req.user;
  const ip     = req.ip;
  const ua     = req.headers['user-agent'] || null;

  const {
    name, tax_id, sector, employee_count,
    contact_email, contact_phone, address, coordinator_name,
    contract_start, contract_end,
    service_fee_type, service_fee_amount,
    credit_limit, currency, payment_term_days,
    status, notes,
  } = req.body;

  try {
    const { rows } = await pool.query(
      `INSERT INTO corporates (
         name, tax_id, sector, employee_count,
         contact_email, contact_phone, address, coordinator_name,
         contract_start, contract_end,
         service_fee_type, service_fee_amount,
         credit_limit, currency, payment_term_days,
         status, notes, created_by
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING ${CORPORATE_PUBLIC_COLS}`,
      [
        name, tax_id, sector || null, employee_count || null,
        contact_email, contact_phone || null,
        address ? JSON.stringify(address) : null,
        coordinator_name || null,
        contract_start || null, contract_end || null,
        service_fee_type || 'FLAT', service_fee_amount || 0,
        credit_limit || 0, currency || 'USD', payment_term_days || 30,
        status || 'active', notes || null, caller.id,
      ]
    );

    await writeAudit({
      userId: caller.id, action: 'CORPORATE_CREATE',
      resourceType: 'corporate', resourceId: rows[0].id,
      ipAddress: ip, userAgent: ua,
      payload: { name, tax_id, contact_email },
      result: 'success',
    });

    return res.status(201).json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Tax ID already registered' });
    console.error('[CORP] createCorporate error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// PATCH /corporates/:id
// ---------------------------------------------------------------------------
async function updateCorporate(req, res) {
  const { id } = req.params;
  const caller = req.user;
  const ip     = req.ip;
  const ua     = req.headers['user-agent'] || null;

  const UPDATABLE = [
    'name','sector','employee_count','contact_email','contact_phone',
    'address','coordinator_name','contract_start','contract_end',
    'service_fee_type','service_fee_amount','credit_limit','currency',
    'payment_term_days','status','notes',
  ];

  const setClauses = [];
  const values     = [];

  for (const field of UPDATABLE) {
    if (req.body[field] !== undefined) {
      values.push(field === 'address' ? JSON.stringify(req.body[field]) : req.body[field]);
      setClauses.push(`${field} = $${values.length}`);
    }
  }

  if (setClauses.length === 0) return res.status(400).json({ error: 'No fields to update' });

  values.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE corporates
       SET    ${setClauses.join(', ')}, updated_at = NOW()
       WHERE  id = $${values.length}
       RETURNING ${CORPORATE_PUBLIC_COLS}`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: 'Corporate not found' });

    await writeAudit({
      userId: caller.id, action: 'CORPORATE_UPDATE',
      resourceType: 'corporate', resourceId: id,
      ipAddress: ip, userAgent: ua,
      payload: { fields: Object.keys(req.body) },
      result: 'success',
    });

    return res.status(200).json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Tax ID already registered' });
    console.error('[CORP] updateCorporate error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// DELETE /corporates/:id  (soft-delete)
// ---------------------------------------------------------------------------
async function deleteCorporate(req, res) {
  const { id } = req.params;
  const caller = req.user;
  const ip     = req.ip;
  const ua     = req.headers['user-agent'] || null;

  try {
    const { rows } = await pool.query(
      `UPDATE corporates SET status = 'inactive', updated_at = NOW()
       WHERE id = $1 AND status <> 'inactive'
       RETURNING id`,
      [id]
    );

    if (!rows[0]) {
      const exists = await pool.query('SELECT id FROM corporates WHERE id = $1', [id]);
      if (!exists.rows[0]) return res.status(404).json({ error: 'Corporate not found' });
      return res.status(200).json({ message: 'Corporate is already inactive' });
    }

    await writeAudit({
      userId: caller.id, action: 'CORPORATE_DEACTIVATE',
      resourceType: 'corporate', resourceId: id,
      ipAddress: ip, userAgent: ua, result: 'success',
    });

    return res.status(200).json({ message: 'Corporate deactivated successfully' });
  } catch (err) {
    console.error('[CORP] deleteCorporate error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// =============================================================================
// EMPLOYEES
// =============================================================================

// ---------------------------------------------------------------------------
// GET /corporates/:id/employees
// ---------------------------------------------------------------------------
async function listEmployees(req, res) {
  const { id } = req.params;
  const { page = 1, limit = 20, status, search } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  try {
    if (!(await assertCorporateExists(id, res))) return;

    const conditions = [`corporate_id = $1`];
    const values     = [id];

    if (status) {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(name ILIKE $${values.length} OR email ILIKE $${values.length})`);
    }

    const where       = `WHERE ${conditions.join(' AND ')}`;
    const countValues = [...values];

    const listQuery = async (cols) => Promise.all([
      pool.query(`SELECT COUNT(*) FROM corporate_employees ${where}`, countValues),
      pool.query(
        `SELECT ${cols}, (passport_enc IS NOT NULL) AS passport_enc
         FROM   corporate_employees
         ${where}
         ORDER  BY name ASC
         LIMIT  $${values.length + 1}
         OFFSET $${values.length + 2}`,
        [...values, Number(limit), offset]
      ),
    ]);

    let countResult, dataResult;
    try {
      [countResult, dataResult] = await listQuery(EMPLOYEE_PUBLIC_COLS);
    } catch (colErr) {
      if (colErr.code === '42703') {
        console.warn('[CORP] listEmployees: profile columns missing, using legacy select.');
        [countResult, dataResult] = await listQuery(EMPLOYEE_CORE_COLS);
      } else { throw colErr; }
    }

    const total = parseInt(countResult.rows[0].count, 10);
    return res.status(200).json({
      data: dataResult.rows.map(toPublicEmployee),
      meta: { total, page: Number(page), limit: Number(limit), total_pages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error('[CORP] listEmployees error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// GET /corporates/:id/employees/:eid
// ---------------------------------------------------------------------------
async function getEmployee(req, res) {
  const { id, eid } = req.params;

  const fetchEmployee = async (cols) => pool.query(
    `SELECT ${cols}, (passport_enc IS NOT NULL) AS passport_enc
     FROM   corporate_employees
     WHERE  id = $1 AND corporate_id = $2 LIMIT 1`,
    [eid, id]
  );
  try {
    let rows;
    try {
      ({ rows } = await fetchEmployee(EMPLOYEE_PUBLIC_COLS));
    } catch (colErr) {
      if (colErr.code === '42703') { ({ rows } = await fetchEmployee(EMPLOYEE_CORE_COLS)); }
      else throw colErr;
    }
    if (!rows[0]) return res.status(404).json({ error: 'Employee not found' });
    return res.status(200).json({ data: toPublicEmployee(rows[0]) });
  } catch (err) {
    console.error('[CORP] getEmployee error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// POST /corporates/:id/employees
// ---------------------------------------------------------------------------
async function createEmployee(req, res) {
  const { id }  = req.params;
  const caller  = req.user;
  const ip      = req.ip;
  const ua      = req.headers['user-agent'] || null;

  try {
    if (!(await assertCorporateExists(id, res))) return;
  } catch (err) {
    console.error('[CORP] createEmployee corp check error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  const {
    name, title, department, email, phone, passport, cabin_tier,
    employee_number, cost_center, nationality, date_of_birth,
    frequent_flyers, preferences,
  } = req.body;

  // Encrypt passport JSON if provided
  let passportEnc = null, ivPassport = null;
  if (passport) {
    try {
      const { ciphertext, iv } = encrypt(JSON.stringify(passport));
      passportEnc = ciphertext;
      ivPassport  = iv;
    } catch (err) {
      console.error('[CORP] createEmployee encrypt error:', err.message);
      return res.status(500).json({ error: 'Passport encryption failed' });
    }
  }

  // Try with new profile columns first; if migration not yet applied fall back to legacy columns
  const fullInsert = async () => pool.query(
    `INSERT INTO corporate_employees
       (corporate_id, name, title, department, email, phone,
        employee_number, cost_center, nationality, date_of_birth,
        passport_enc, iv_passport, cabin_tier,
        frequent_flyers, preferences)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${EMPLOYEE_PUBLIC_COLS}, (passport_enc IS NOT NULL) AS passport_enc`,
    [
      id, name, title || null, department || null, email, phone || null,
      employee_number || null, cost_center || null,
      nationality || null, date_of_birth || null,
      passportEnc, ivPassport, cabin_tier || null,
      frequent_flyers ? JSON.stringify(frequent_flyers) : null,
      preferences     ? JSON.stringify(preferences)     : null,
    ]
  );

  const legacyInsert = async () => pool.query(
    `INSERT INTO corporate_employees
       (corporate_id, name, title, department, email, phone,
        passport_enc, iv_passport, cabin_tier)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, corporate_id, name, title, department,
               email, phone, cabin_tier, status, created_at,
               (passport_enc IS NOT NULL) AS passport_enc`,
    [id, name, title || null, department || null, email, phone || null,
     passportEnc, ivPassport, cabin_tier || null]
  );

  try {
    let rows;
    try {
      ({ rows } = await fullInsert());
    } catch (err) {
      if (err.code === '42703') {
        // New profile columns not migrated yet — fall back to legacy
        console.warn('[CORP] createEmployee: profile columns missing, using legacy insert. Run DB migration.');
        ({ rows } = await legacyInsert());
      } else {
        throw err;
      }
    }

    await writeAudit({
      userId: caller.id, action: 'EMPLOYEE_CREATE',
      resourceType: 'corporate_employee', resourceId: rows[0].id,
      ipAddress: ip, userAgent: ua,
      payload: { corporate_id: id, name, email },
      result: 'success',
    });

    return res.status(201).json({ data: toPublicEmployee(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Employee email already registered for this corporate' });
    console.error('[CORP] createEmployee insert error:', err.message, err.detail || '');
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// PATCH /corporates/:id/employees/:eid
// ---------------------------------------------------------------------------
async function updateEmployee(req, res) {
  const { id, eid } = req.params;
  const caller      = req.user;
  const ip          = req.ip;
  const ua          = req.headers['user-agent'] || null;

  // Fetch existing to get current encrypted passport
  let existing;
  try {
    const { rows } = await pool.query(
      `SELECT id, passport_enc, iv_passport FROM corporate_employees
       WHERE id = $1 AND corporate_id = $2 LIMIT 1`,
      [eid, id]
    );
    existing = rows[0];
  } catch (err) {
    console.error('[CORP] updateEmployee fetch error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!existing) return res.status(404).json({ error: 'Employee not found' });

  const {
    name, title, department, email, phone, passport, cabin_tier, status,
    employee_number, cost_center, nationality, date_of_birth,
    frequent_flyers, preferences,
  } = req.body;

  // Re-encrypt passport if a new value was provided
  let passportResult;
  try {
    const passportStr = passport !== undefined ? JSON.stringify(passport) : undefined;
    passportResult = encryptIfProvided(passportStr, existing.passport_enc, existing.iv_passport);
  } catch (err) {
    console.error('[CORP] updateEmployee encrypt error:', err.message);
    return res.status(500).json({ error: 'Passport encryption failed' });
  }

  const setClauses = [];
  const values     = [];

  const addField = (col, val) => { values.push(val); setClauses.push(`${col} = $${values.length}`); };

  if (name            !== undefined) addField('name',            name);
  if (title           !== undefined) addField('title',           title);
  if (department      !== undefined) addField('department',      department);
  if (email           !== undefined) addField('email',           email);
  if (phone           !== undefined) addField('phone',           phone);
  if (employee_number !== undefined) addField('employee_number', employee_number);
  if (cost_center     !== undefined) addField('cost_center',     cost_center);
  if (nationality     !== undefined) addField('nationality',     nationality);
  if (date_of_birth   !== undefined) addField('date_of_birth',   date_of_birth);
  if (cabin_tier      !== undefined) addField('cabin_tier',      cabin_tier);
  if (status          !== undefined) addField('status',          status);
  if (frequent_flyers !== undefined) addField('frequent_flyers', JSON.stringify(frequent_flyers));
  if (preferences     !== undefined) addField('preferences',     JSON.stringify(preferences));
  if (passport        !== undefined) {
    addField('passport_enc', passportResult.enc);
    addField('iv_passport',  passportResult.iv);
  }

  // Strip new profile columns from SET if migration not yet applied
  const NEW_PROFILE_COLS = new Set(['employee_number','cost_center','nationality','date_of_birth','frequent_flyers','preferences']);

  if (setClauses.length === 0) return res.status(400).json({ error: 'No fields to update' });

  values.push(eid, id);
  try {
    let rows;
    try {
      ({ rows } = await pool.query(
        `UPDATE corporate_employees
         SET    ${setClauses.join(', ')}
         WHERE  id = $${values.length - 1} AND corporate_id = $${values.length}
         RETURNING ${EMPLOYEE_PUBLIC_COLS}, (passport_enc IS NOT NULL) AS passport_enc`,
        values
      ));
    } catch (err) {
      if (err.code === '42703') {
        // Fall back: rebuild SET clauses without new profile columns
        console.warn('[CORP] updateEmployee: profile columns missing, using legacy update.');
        const legacySet    = [];
        const legacyValues = [];
        const addLegacy    = (col, val) => { legacyValues.push(val); legacySet.push(`${col} = $${legacyValues.length}`); };
        if (name       !== undefined) addLegacy('name',       name);
        if (title      !== undefined) addLegacy('title',      title);
        if (department !== undefined) addLegacy('department', department);
        if (email      !== undefined) addLegacy('email',      email);
        if (phone      !== undefined) addLegacy('phone',      phone);
        if (cabin_tier !== undefined) addLegacy('cabin_tier', cabin_tier);
        if (status     !== undefined) addLegacy('status',     status);
        if (passport   !== undefined) { addLegacy('passport_enc', passportResult.enc); addLegacy('iv_passport', passportResult.iv); }
        if (!legacySet.length) return res.status(400).json({ error: 'No updatable fields' });
        legacyValues.push(eid, id);
        ({ rows } = await pool.query(
          `UPDATE corporate_employees SET ${legacySet.join(', ')}
           WHERE id = $${legacyValues.length - 1} AND corporate_id = $${legacyValues.length}
           RETURNING id, corporate_id, name, title, department, email, phone, cabin_tier, status, created_at,
                     (passport_enc IS NOT NULL) AS passport_enc`,
          legacyValues
        ));
      } else {
        throw err;
      }
    }
    if (!rows[0]) return res.status(404).json({ error: 'Employee not found' });

    await writeAudit({
      userId: caller.id, action: 'EMPLOYEE_UPDATE',
      resourceType: 'corporate_employee', resourceId: eid,
      ipAddress: ip, userAgent: ua,
      payload: { fields: Object.keys(req.body).filter(k => k !== 'passport') },
      result: 'success',
    });

    return res.status(200).json({ data: toPublicEmployee(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Employee email already registered for this corporate' });
    console.error('[CORP] updateEmployee update error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// DELETE /corporates/:id/employees/:eid  (soft-delete)
// ---------------------------------------------------------------------------
async function deleteEmployee(req, res) {
  const { id, eid } = req.params;
  const caller      = req.user;
  const ip          = req.ip;
  const ua          = req.headers['user-agent'] || null;

  try {
    const { rows } = await pool.query(
      `UPDATE corporate_employees SET status = 'inactive'
       WHERE id = $1 AND corporate_id = $2 AND status <> 'inactive'
       RETURNING id`,
      [eid, id]
    );
    if (!rows[0]) {
      const exists = await pool.query(
        'SELECT id FROM corporate_employees WHERE id = $1 AND corporate_id = $2', [eid, id]
      );
      if (!exists.rows[0]) return res.status(404).json({ error: 'Employee not found' });
      return res.status(200).json({ message: 'Employee is already inactive' });
    }

    await writeAudit({
      userId: caller.id, action: 'EMPLOYEE_DEACTIVATE',
      resourceType: 'corporate_employee', resourceId: eid,
      ipAddress: ip, userAgent: ua, result: 'success',
    });

    return res.status(200).json({ message: 'Employee deactivated successfully' });
  } catch (err) {
    console.error('[CORP] deleteEmployee error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// POST /corporates/:id/employees/import  — bulk create from Excel/CSV parse
// ---------------------------------------------------------------------------
async function importEmployees(req, res) {
  const { id }   = req.params;
  const caller   = req.user;
  const ip       = req.ip;
  const ua       = req.headers['user-agent'] || null;

  try {
    if (!(await assertCorporateExists(id, res))) return;
  } catch (err) {
    console.error('[CORP] importEmployees corp check error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  const { employees } = req.body;

  const created  = [];
  const skipped  = [];

  for (const emp of employees) {
    const {
      name, title, department, email, phone,
      employee_number, cost_center, nationality, date_of_birth,
      passport, cabin_tier, frequent_flyers, preferences,
    } = emp;

    let passportEnc = null, ivPassport = null;
    if (passport) {
      try {
        const { ciphertext, iv } = encrypt(JSON.stringify(passport));
        passportEnc = ciphertext;
        ivPassport  = iv;
      } catch (_) { /* skip encryption failure, continue */ }
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO corporate_employees
           (corporate_id, name, title, department, email, phone,
            employee_number, cost_center, nationality, date_of_birth,
            passport_enc, iv_passport, cabin_tier, frequent_flyers, preferences)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (corporate_id, email) DO NOTHING
         RETURNING id, email`,
        [
          id, name, title || null, department || null, email, phone || null,
          employee_number || null, cost_center || null,
          nationality || null, date_of_birth || null,
          passportEnc, ivPassport, cabin_tier || null,
          frequent_flyers ? JSON.stringify(frequent_flyers) : null,
          preferences     ? JSON.stringify(preferences)     : null,
        ]
      );
      if (rows[0]) {
        created.push(rows[0].id);
      } else {
        skipped.push(email); // already exists
      }
    } catch (err) {
      console.error('[CORP] importEmployees row error:', err.message);
      skipped.push(email);
    }
  }

  await writeAudit({
    userId: caller.id, action: 'EMPLOYEE_IMPORT',
    resourceType: 'corporate_employee', resourceId: id,
    ipAddress: ip, userAgent: ua,
    payload: { total: employees.length, created: created.length, skipped: skipped.length },
    result: 'success',
  });

  return res.status(201).json({
    data: { created: created.length, skipped: skipped.length, skipped_emails: skipped },
  });
}

// =============================================================================
// TRAVEL POLICY
// =============================================================================

// ---------------------------------------------------------------------------
// GET /corporates/:id/policy
// ---------------------------------------------------------------------------
async function getPolicy(req, res) {
  const { id } = req.params;

  try {
    if (!(await assertCorporateExists(id, res))) return;

    const { rows } = await pool.query(
      `SELECT * FROM corporate_travel_policies WHERE corporate_id = $1 LIMIT 1`,
      [id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'No travel policy found for this corporate' });
    return res.status(200).json({ data: rows[0] });
  } catch (err) {
    console.error('[CORP] getPolicy error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// PUT /corporates/:id/policy  (upsert)
// ---------------------------------------------------------------------------
async function upsertPolicy(req, res) {
  const { id }  = req.params;
  const caller  = req.user;
  const ip      = req.ip;
  const ua      = req.headers['user-agent'] || null;

  try {
    if (!(await assertCorporateExists(id, res))) return;
  } catch (err) {
    console.error('[CORP] upsertPolicy corp check error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  const {
    domestic_cabin, intl_short_cabin, intl_long_cabin,
    long_haul_threshold_hours,
    max_domestic_fare, max_intl_fare, max_hotel_per_night,
    min_advance_days,
    require_refundable_above, require_approval_above,
    approver_user_id,
    effective_from, effective_to,
  } = req.body;

  try {
    const { rows } = await pool.query(
      `INSERT INTO corporate_travel_policies (
         corporate_id,
         domestic_cabin, intl_short_cabin, intl_long_cabin,
         long_haul_threshold_hours,
         max_domestic_fare, max_intl_fare, max_hotel_per_night,
         min_advance_days,
         require_refundable_above, require_approval_above,
         approver_user_id,
         effective_from, effective_to
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (corporate_id) DO UPDATE SET
         domestic_cabin              = EXCLUDED.domestic_cabin,
         intl_short_cabin            = EXCLUDED.intl_short_cabin,
         intl_long_cabin             = EXCLUDED.intl_long_cabin,
         long_haul_threshold_hours   = EXCLUDED.long_haul_threshold_hours,
         max_domestic_fare           = EXCLUDED.max_domestic_fare,
         max_intl_fare               = EXCLUDED.max_intl_fare,
         max_hotel_per_night         = EXCLUDED.max_hotel_per_night,
         min_advance_days            = EXCLUDED.min_advance_days,
         require_refundable_above    = EXCLUDED.require_refundable_above,
         require_approval_above      = EXCLUDED.require_approval_above,
         approver_user_id            = EXCLUDED.approver_user_id,
         effective_from              = EXCLUDED.effective_from,
         effective_to                = EXCLUDED.effective_to,
         updated_at                  = NOW()
       RETURNING *`,
      [
        id,
        domestic_cabin         || 'economy',
        intl_short_cabin       || 'economy',
        intl_long_cabin        || 'business',
        long_haul_threshold_hours ?? 4,
        max_domestic_fare      ?? null,
        max_intl_fare          ?? null,
        max_hotel_per_night    ?? null,
        min_advance_days       ?? 3,
        require_refundable_above  ?? null,
        require_approval_above    ?? null,
        approver_user_id       ?? null,
        effective_from         || new Date().toISOString().split('T')[0],
        effective_to           ?? null,
      ]
    );

    await writeAudit({
      userId: caller.id, action: 'POLICY_UPSERT',
      resourceType: 'corporate_travel_policy', resourceId: rows[0].id,
      ipAddress: ip, userAgent: ua,
      payload: { corporate_id: id, effective_from, effective_to },
      result: 'success',
    });

    return res.status(200).json({ data: rows[0] });
  } catch (err) {
    console.error('[CORP] upsertPolicy error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// =============================================================================
// FINANCIAL SUMMARY
// =============================================================================

// ---------------------------------------------------------------------------
// GET /corporates/:id/financial
// ---------------------------------------------------------------------------
async function getFinancial(req, res) {
  const { id } = req.params;

  try {
    // Corporate credit data + booking aggregate in one round-trip
    const [corpResult, statsResult] = await Promise.all([
      pool.query(
        `SELECT name, credit_limit, credit_used, currency, payment_term_days,
                service_fee_type, service_fee_amount, contract_start, contract_end
         FROM   corporates WHERE id = $1 LIMIT 1`,
        [id]
      ),
      pool.query(
        `SELECT
           COUNT(*)                                              AS total_bookings,
           COUNT(*) FILTER (WHERE status = 'confirmed')         AS confirmed,
           COUNT(*) FILTER (WHERE status = 'ticketed')          AS ticketed,
           COUNT(*) FILTER (WHERE status = 'cancelled')         AS cancelled,
           COALESCE(SUM(total_amount)
             FILTER (WHERE status NOT IN ('cancelled','refunded','void')), 0) AS total_spend_cents,
           COALESCE(SUM(service_fee)
             FILTER (WHERE status NOT IN ('cancelled','refunded','void')), 0) AS total_fees_cents,
           COUNT(*) FILTER (WHERE in_policy = false)            AS out_of_policy_count,
           COUNT(*) FILTER (WHERE policy_override = true)       AS override_count
         FROM bookings WHERE corporate_id = $1`,
        [id]
      ),
    ]);

    const corp = corpResult.rows[0];
    if (!corp) return res.status(404).json({ error: 'Corporate not found' });

    const stats = statsResult.rows[0];

    return res.status(200).json({
      data: {
        corporate_name     : corp.name,
        currency           : corp.currency,
        credit_limit_cents : corp.credit_limit,
        credit_used_cents  : corp.credit_used,
        credit_available_cents: Math.max(0, corp.credit_limit - corp.credit_used),
        utilization_percent: corp.credit_limit > 0
          ? parseFloat(((corp.credit_used / corp.credit_limit) * 100).toFixed(2))
          : 0,
        payment_term_days  : corp.payment_term_days,
        service_fee_type   : corp.service_fee_type,
        service_fee_amount : corp.service_fee_amount,
        contract_start     : corp.contract_start,
        contract_end       : corp.contract_end,
        booking_stats: {
          total            : parseInt(stats.total_bookings, 10),
          confirmed        : parseInt(stats.confirmed,      10),
          ticketed         : parseInt(stats.ticketed,       10),
          cancelled        : parseInt(stats.cancelled,      10),
          total_spend_cents: parseInt(stats.total_spend_cents, 10),
          total_fees_cents : parseInt(stats.total_fees_cents,  10),
          out_of_policy    : parseInt(stats.out_of_policy_count, 10),
          overrides        : parseInt(stats.override_count,   10),
        },
      },
    });
  } catch (err) {
    console.error('[CORP] getFinancial error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// =============================================================================
// BOOKINGS (read-only list — write is handled by bookings module)
// =============================================================================

// ---------------------------------------------------------------------------
// GET /corporates/:id/bookings
// ---------------------------------------------------------------------------
async function listCorporateBookings(req, res) {
  const { id } = req.params;
  const { page = 1, limit = 20, status, from, to, employee_id } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  try {
    if (!(await assertCorporateExists(id, res))) return;

    const conditions = [`b.corporate_id = $1`];
    const values     = [id];

    if (status) {
      values.push(status);
      conditions.push(`b.status = $${values.length}`);
    }
    if (employee_id) {
      values.push(employee_id);
      conditions.push(`b.employee_id = $${values.length}`);
    }
    if (from) {
      values.push(from);
      conditions.push(`b.departure_at >= $${values.length}`);
    }
    if (to) {
      values.push(to);
      conditions.push(`b.departure_at <= $${values.length}`);
    }

    const where       = `WHERE ${conditions.join(' AND ')}`;
    const countValues = [...values];

    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM bookings b ${where}`, countValues),
      pool.query(
        `SELECT
           b.id, b.pnr, b.employee_id, b.consultant_id,
           b.origin_iata, b.dest_iata,
           b.departure_at, b.arrival_at,
           b.cabin_class, b.fare_brand,
           b.base_fare, b.taxes, b.service_fee, b.total_amount, b.currency,
           b.in_policy, b.policy_override, b.override_reason,
           b.status, b.booked_at, b.cancelled_at,
           e.name AS employee_name,
           u.name AS consultant_name
         FROM   bookings b
         JOIN   corporate_employees e ON e.id = b.employee_id
         JOIN   users u               ON u.id = b.consultant_id
         ${where}
         ORDER  BY b.booked_at DESC
         LIMIT  $${values.length + 1}
         OFFSET $${values.length + 2}`,
        [...values, Number(limit), offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);
    return res.status(200).json({
      data: dataResult.rows,
      meta: { total, page: Number(page), limit: Number(limit), total_pages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error('[CORP] listCorporateBookings error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  // Corporates
  listCorporates, getCorporate, createCorporate, updateCorporate, deleteCorporate,
  // Employees
  listEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee, importEmployees,
  // Policy
  getPolicy, upsertPolicy,
  // Financial
  getFinancial,
  // Bookings
  listCorporateBookings,
};
