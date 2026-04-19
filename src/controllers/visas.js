const pool           = require('../config/db')
const { writeAudit } = require('../utils/audit')
const { checkVisa }  = require('../utils/visaRules')

// ---------------------------------------------------------------------------
// GET /visas/check?nationality=TR&destination=DE
// ---------------------------------------------------------------------------
async function eligibilityCheck(req, res) {
  const { nationality, destination } = req.query
  if (!nationality || !destination) {
    return res.status(400).json({ error: 'nationality and destination query params required' })
  }
  const result = checkVisa(nationality, destination)
  return res.json({ data: result })
}

// ---------------------------------------------------------------------------
// GET /visas/stats
// ---------------------------------------------------------------------------
async function getStats(req, res) {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                          AS total,
        COUNT(*) FILTER (WHERE status = 'draft')         AS draft,
        COUNT(*) FILTER (WHERE status = 'submitted')     AS submitted,
        COUNT(*) FILTER (WHERE status = 'in_review')     AS in_review,
        COUNT(*) FILTER (WHERE status = 'approved')      AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected')      AS rejected,
        COUNT(*) FILTER (
          WHERE status = 'approved'
          AND expiry_date IS NOT NULL
          AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
        )                                                 AS expiring_soon,
        COUNT(*) FILTER (
          WHERE status NOT IN ('approved','rejected','expired')
          AND application_deadline IS NOT NULL
          AND application_deadline <= CURRENT_DATE + 14
        )                                                 AS deadline_soon
      FROM visa_applications
    `)
    return res.json({ data: rows[0] })
  } catch (err) {
    console.error('[VISAS] getStats error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ---------------------------------------------------------------------------
// GET /visas
// ---------------------------------------------------------------------------
async function listVisas(req, res) {
  const { page = 1, limit = 20, status, corporate_id, employee_id, search } = req.query
  const offset = (Number(page) - 1) * Number(limit)

  const conditions = []
  const params     = []

  if (status)       { params.push(status);       conditions.push(`v.status = $${params.length}`) }
  if (corporate_id) { params.push(corporate_id); conditions.push(`v.corporate_id = $${params.length}`) }
  if (employee_id)  { params.push(employee_id);  conditions.push(`v.employee_id = $${params.length}`) }
  if (search) {
    params.push(`%${search}%`)
    conditions.push(`(e.name ILIKE $${params.length} OR c.name ILIKE $${params.length} OR v.dest_country ILIKE $${params.length} OR v.reference_number ILIKE $${params.length})`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM visa_applications v
       JOIN corporate_employees e ON e.id = v.employee_id
       JOIN corporates c ON c.id = v.corporate_id
       ${where}`, params
    )
    const total = parseInt(countRes.rows[0].count, 10)

    const { rows } = await pool.query(
      `SELECT v.*,
              e.name  AS employee_name, e.email AS employee_email,
              c.name  AS corporate_name,
              u.name  AS consultant_name
       FROM visa_applications v
       JOIN corporate_employees e ON e.id = v.employee_id
       JOIN corporates c          ON c.id = v.corporate_id
       JOIN users u               ON u.id = v.consultant_id
       ${where}
       ORDER BY v.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, Number(limit), offset]
    )

    return res.json({
      data: rows,
      meta: { total, page: Number(page), limit: Number(limit), total_pages: Math.ceil(total / Number(limit)) },
    })
  } catch (err) {
    console.error('[VISAS] listVisas error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ---------------------------------------------------------------------------
// POST /visas
// ---------------------------------------------------------------------------
async function createVisa(req, res) {
  const caller = req.user
  const ip     = req.ip
  const ua     = req.headers['user-agent'] || null

  const {
    corporate_id, employee_id, booking_id,
    origin_country, dest_country, travel_date, return_date,
    visa_type, passport_number, passport_nationality, passport_expiry,
    application_deadline, notes,
  } = req.body

  // Auto-check eligibility
  const eligibility = passport_nationality
    ? checkVisa(passport_nationality, dest_country)
    : null

  try {
    const { rows } = await pool.query(
      `INSERT INTO visa_applications (
         corporate_id, employee_id, consultant_id, booking_id,
         origin_country, dest_country, travel_date, return_date,
         visa_type, passport_number, passport_nationality, passport_expiry,
         application_deadline, notes, eligibility_result, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'draft')
       RETURNING *`,
      [
        corporate_id, employee_id, caller.id, booking_id || null,
        origin_country, dest_country, travel_date, return_date || null,
        visa_type || null,
        passport_number || null, passport_nationality || null,
        passport_expiry || null,
        application_deadline || null, notes || null,
        eligibility?.result || null,
      ]
    )

    await writeAudit({
      userId: caller.id, action: 'VISA_CREATE',
      resourceType: 'visa_application', resourceId: rows[0].id,
      ipAddress: ip, userAgent: ua,
      payload: { corporate_id, employee_id, dest_country, travel_date },
      result: 'success',
    })

    return res.status(201).json({ data: rows[0] })
  } catch (err) {
    console.error('[VISAS] createVisa error:', err.message, err.detail || '')
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ---------------------------------------------------------------------------
// GET /visas/:id
// ---------------------------------------------------------------------------
async function getVisa(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT v.*,
              e.name  AS employee_name, e.email AS employee_email,
              c.name  AS corporate_name,
              u.name  AS consultant_name,
              b.pnr   AS booking_pnr
       FROM visa_applications v
       JOIN corporate_employees e ON e.id = v.employee_id
       JOIN corporates c          ON c.id = v.corporate_id
       JOIN users u               ON u.id = v.consultant_id
       LEFT JOIN bookings b       ON b.id = v.booking_id
       WHERE v.id = $1`,
      [req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Visa application not found' })
    return res.json({ data: rows[0] })
  } catch (err) {
    console.error('[VISAS] getVisa error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ---------------------------------------------------------------------------
// PATCH /visas/:id
// ---------------------------------------------------------------------------
async function updateVisa(req, res) {
  const caller = req.user
  const ip     = req.ip
  const ua     = req.headers['user-agent'] || null

  const {
    status, reference_number, applied_at, decision_at,
    expiry_date, application_deadline, notes,
    visa_type, passport_number, passport_nationality, passport_expiry,
    travel_date, return_date,
  } = req.body

  try {
    const { rows: found } = await pool.query('SELECT id FROM visa_applications WHERE id = $1', [req.params.id])
    if (!found[0]) return res.status(404).json({ error: 'Visa application not found' })

    const { rows } = await pool.query(
      `UPDATE visa_applications SET
         status               = COALESCE($1,  status),
         reference_number     = COALESCE($2,  reference_number),
         applied_at           = COALESCE($3,  applied_at),
         decision_at          = COALESCE($4,  decision_at),
         expiry_date          = COALESCE($5,  expiry_date),
         application_deadline = COALESCE($6,  application_deadline),
         notes                = COALESCE($7,  notes),
         visa_type            = COALESCE($8,  visa_type),
         passport_number      = COALESCE($9,  passport_number),
         passport_nationality = COALESCE($10, passport_nationality),
         passport_expiry      = COALESCE($11, passport_expiry),
         travel_date          = COALESCE($12, travel_date),
         return_date          = COALESCE($13, return_date),
         updated_at           = NOW()
       WHERE id = $14
       RETURNING *`,
      [
        status || null, reference_number || null,
        applied_at || null, decision_at || null,
        expiry_date || null, application_deadline || null,
        notes !== undefined ? notes : null,
        visa_type || null, passport_number || null,
        passport_nationality || null, passport_expiry || null,
        travel_date || null, return_date || null,
        req.params.id,
      ]
    )

    await writeAudit({
      userId: caller.id, action: 'VISA_UPDATE',
      resourceType: 'visa_application', resourceId: req.params.id,
      ipAddress: ip, userAgent: ua,
      payload: { status, reference_number },
      result: 'success',
    })

    return res.json({ data: rows[0] })
  } catch (err) {
    console.error('[VISAS] updateVisa error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ---------------------------------------------------------------------------
// DELETE /visas/:id  (draft only)
// ---------------------------------------------------------------------------
async function deleteVisa(req, res) {
  try {
    const { rows } = await pool.query(
      `DELETE FROM visa_applications WHERE id = $1 AND status = 'draft' RETURNING id`,
      [req.params.id]
    )
    if (!rows[0]) return res.status(400).json({ error: 'Only draft applications can be deleted' })
    return res.json({ data: { id: rows[0].id } })
  } catch (err) {
    console.error('[VISAS] deleteVisa error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

module.exports = { eligibilityCheck, getStats, listVisas, createVisa, getVisa, updateVisa, deleteVisa }
