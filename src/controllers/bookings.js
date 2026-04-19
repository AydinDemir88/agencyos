const crypto         = require('crypto')
const pool           = require('../config/db')
const { writeAudit } = require('../utils/audit')

// Generate a random 6-char alphanumeric PNR
function generatePNR() {
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6)
}

// ---------------------------------------------------------------------------
// POST /bookings  (OrderCreate)
// ---------------------------------------------------------------------------
async function createBooking(req, res) {
  const caller = req.user
  const ip     = req.ip
  const ua     = req.headers['user-agent'] || null

  const {
    corporate_id, employee_id, airline_config_id,
    origin_iata, dest_iata, departure_at, arrival_at,
    cabin_class, fare_brand,
    base_fare, taxes, service_fee, total_amount, currency,
    in_policy, policy_override, override_reason,
    ndc_offer_id, selected_seat, selected_services,
  } = req.body

  try {
    const { rows: creditRows } = await pool.query(
      `SELECT credit_limit, credit_used FROM corporates WHERE id = $1`,
      [corporate_id]
    )
    if (!creditRows[0]) return res.status(404).json({ error: 'Corporate not found' })
    const { credit_limit, credit_used } = creditRows[0]
    if (credit_used + total_amount > credit_limit) {
      const available = credit_limit - credit_used
      return res.status(400).json({
        error: `Insufficient credit limit. Available: ${available} ${currency}, required: ${total_amount} ${currency}`,
      })
    }

    let pnr = generatePNR()
    const existing = await pool.query('SELECT id FROM bookings WHERE pnr = $1', [pnr])
    if (existing.rows.length > 0) pnr = generatePNR()

    const { rows } = await pool.query(
      `INSERT INTO bookings (
         pnr, corporate_id, employee_id, consultant_id, airline_config_id,
         origin_iata, dest_iata, departure_at, arrival_at,
         cabin_class, fare_brand,
         base_fare, taxes, service_fee, total_amount, currency,
         in_policy, policy_override, override_reason,
         ndc_offer_id, selected_seat, selected_services, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'confirmed')
       RETURNING *`,
      [
        pnr, corporate_id, employee_id, caller.id, airline_config_id || null,
        origin_iata, dest_iata, departure_at, arrival_at,
        cabin_class, fare_brand || null,
        base_fare, taxes, service_fee, total_amount, currency,
        in_policy, policy_override, override_reason || null,
        ndc_offer_id || null,
        selected_seat || null,
        JSON.stringify(selected_services || []),
      ]
    )

    await pool.query(
      `UPDATE corporates SET credit_used = credit_used + $1, updated_at = NOW() WHERE id = $2`,
      [total_amount, corporate_id]
    )

    await writeAudit({
      userId: caller.id, action: 'BOOKING_CREATE',
      resourceType: 'booking', resourceId: rows[0].id,
      ipAddress: ip, userAgent: ua,
      payload: { pnr, corporate_id, employee_id, origin_iata, dest_iata, total_amount, in_policy },
      result: 'success',
    })

    return res.status(201).json({ data: rows[0] })
  } catch (err) {
    console.error('[BOOKINGS] createBooking error:', err.message, err.detail || '', err.code || '')
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ---------------------------------------------------------------------------
// GET /bookings
// ---------------------------------------------------------------------------
async function listBookings(req, res) {
  const { page = 1, limit = 20, status, corporate_id, search } = req.query
  const offset = (Number(page) - 1) * Number(limit)

  const conditions = []
  const params     = []

  if (status)       { params.push(status);       conditions.push(`b.status = $${params.length}`) }
  if (corporate_id) { params.push(corporate_id); conditions.push(`b.corporate_id = $${params.length}`) }
  if (search) {
    params.push(`%${search}%`)
    conditions.push(`(b.pnr ILIKE $${params.length} OR e.name ILIKE $${params.length} OR c.name ILIKE $${params.length})`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM bookings b
       JOIN corporate_employees e ON e.id = b.employee_id
       JOIN corporates c ON c.id = b.corporate_id
       ${where}`,
      params
    )
    const total = parseInt(countRes.rows[0].count, 10)

    const { rows } = await pool.query(
      `SELECT b.*, e.name AS employee_name, c.name AS corporate_name
       FROM bookings b
       JOIN corporate_employees e ON e.id = b.employee_id
       JOIN corporates c ON c.id = b.corporate_id
       ${where}
       ORDER BY b.booked_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, Number(limit), offset]
    )

    return res.status(200).json({
      data: rows,
      meta: { total, page: Number(page), limit: Number(limit), total_pages: Math.ceil(total / Number(limit)) },
    })
  } catch (err) {
    console.error('[BOOKINGS] listBookings error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ---------------------------------------------------------------------------
// GET /bookings/stats
// ---------------------------------------------------------------------------
async function getStats(req, res) {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE booked_at::date = CURRENT_DATE)                          AS bookings_today,
        COUNT(*) FILTER (WHERE status IN ('confirmed','ticketed'))                       AS active_bookings,
        COUNT(*) FILTER (WHERE status = 'confirmed')                                    AS confirmed,
        COUNT(*) FILTER (WHERE status = 'ticketed')                                     AS ticketed,
        COUNT(*) FILTER (WHERE status IN ('void','cancelled','refunded'))               AS cancelled,
        COALESCE(SUM(total_amount) FILTER (WHERE booked_at::date = CURRENT_DATE), 0)   AS revenue_today,
        COALESCE(SUM(total_amount) FILTER (WHERE status IN ('confirmed','ticketed')), 0) AS active_revenue
      FROM bookings
    `)
    return res.json({ data: rows[0] })
  } catch (err) {
    console.error('[BOOKINGS] getStats error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ---------------------------------------------------------------------------
// GET /bookings/:id
// ---------------------------------------------------------------------------
async function getBooking(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT b.*,
              e.name  AS employee_name,  e.email AS employee_email,
              c.name  AS corporate_name, c.currency AS corporate_currency,
              u.name  AS consultant_name
       FROM bookings b
       JOIN corporate_employees e ON e.id = b.employee_id
       JOIN corporates c          ON c.id = b.corporate_id
       JOIN users u               ON u.id = b.consultant_id
       WHERE b.id = $1`,
      [req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found' })
    return res.json({ data: rows[0] })
  } catch (err) {
    console.error('[BOOKINGS] getBooking error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ---------------------------------------------------------------------------
// PATCH /bookings/:id  (service actions)
// ---------------------------------------------------------------------------
async function serviceBooking(req, res) {
  const caller = req.user
  const ip     = req.ip
  const ua     = req.headers['user-agent'] || null
  const { action, reason, payment_ref } = req.body

  try {
    const { rows: found } = await pool.query(
      `SELECT b.*, c.credit_used FROM bookings b
       JOIN corporates c ON c.id = b.corporate_id
       WHERE b.id = $1`,
      [req.params.id]
    )
    if (!found[0]) return res.status(404).json({ error: 'Booking not found' })
    const booking = found[0]

    // ---- VOID ----
    if (action === 'void') {
      if (!['confirmed', 'pending'].includes(booking.status)) {
        return res.status(400).json({ error: `Cannot void a booking with status '${booking.status}'` })
      }
      const { rows } = await pool.query(
        `UPDATE bookings SET status = 'void', cancelled_at = NOW() WHERE id = $1 RETURNING *`,
        [booking.id]
      )
      await pool.query(
        `UPDATE corporates SET credit_used = GREATEST(credit_used - $1, 0), updated_at = NOW() WHERE id = $2`,
        [booking.total_amount, booking.corporate_id]
      )
      await writeAudit({ userId: caller.id, action: 'BOOKING_VOID', resourceType: 'booking', resourceId: booking.id, ipAddress: ip, userAgent: ua, payload: { reason }, result: 'success' })
      return res.json({ data: rows[0] })
    }

    // ---- REFUND ----
    if (action === 'refund') {
      if (!['confirmed', 'ticketed'].includes(booking.status)) {
        return res.status(400).json({ error: `Cannot refund a booking with status '${booking.status}'` })
      }
      const { rows } = await pool.query(
        `UPDATE bookings SET status = 'refunded', cancelled_at = NOW() WHERE id = $1 RETURNING *`,
        [booking.id]
      )
      await pool.query(
        `UPDATE corporates SET credit_used = GREATEST(credit_used - $1, 0), updated_at = NOW() WHERE id = $2`,
        [booking.total_amount, booking.corporate_id]
      )
      await writeAudit({ userId: caller.id, action: 'BOOKING_REFUND', resourceType: 'booking', resourceId: booking.id, ipAddress: ip, userAgent: ua, payload: { reason }, result: 'success' })
      return res.json({ data: rows[0] })
    }

    // ---- PAYMENT / TICKET ----
    if (action === 'payment') {
      if (booking.status !== 'confirmed') {
        return res.status(400).json({ error: `Cannot record payment for a booking with status '${booking.status}'` })
      }
      const { rows } = await pool.query(
        `UPDATE bookings SET status = 'ticketed', ndc_order_id = $1 WHERE id = $2 RETURNING *`,
        [payment_ref || null, booking.id]
      )
      await writeAudit({ userId: caller.id, action: 'BOOKING_PAYMENT', resourceType: 'booking', resourceId: booking.id, ipAddress: ip, userAgent: ua, payload: { payment_ref }, result: 'success' })
      return res.json({ data: rows[0] })
    }

    return res.status(400).json({ error: 'Unknown action. Use: void, refund, payment' })
  } catch (err) {
    console.error('[BOOKINGS] serviceBooking error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

module.exports = { createBooking, listBookings, getStats, getBooking, serviceBooking }
