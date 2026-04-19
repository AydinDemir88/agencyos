const crypto         = require('crypto')
const pool           = require('../config/db')
const { writeAudit } = require('../utils/audit')

// Generate a random 6-char alphanumeric PNR
function generatePNR() {
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6)
}

// ---------------------------------------------------------------------------
// POST /bookings
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
    ndc_offer_id,
  } = req.body

  try {
    // Check corporate has sufficient credit
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

    // Generate unique PNR (retry once on collision)
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
         ndc_offer_id, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'confirmed')
       RETURNING *`,
      [
        pnr, corporate_id, employee_id, caller.id, airline_config_id || null,
        origin_iata, dest_iata, departure_at, arrival_at,
        cabin_class, fare_brand || null,
        base_fare, taxes, service_fee, total_amount, currency,
        in_policy, policy_override, override_reason || null,
        ndc_offer_id || null,
      ]
    )

    // Update corporate credit_used
    await pool.query(
      `UPDATE corporates
       SET credit_used = credit_used + $1, updated_at = NOW()
       WHERE id = $2`,
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
  const { page = 1, limit = 20 } = req.query
  const offset = (Number(page) - 1) * Number(limit)

  try {
    const { rows } = await pool.query(
      `SELECT b.*, e.name AS employee_name, c.name AS corporate_name
       FROM bookings b
       JOIN corporate_employees e ON e.id = b.employee_id
       JOIN corporates c ON c.id = b.corporate_id
       ORDER BY b.booked_at DESC
       LIMIT $1 OFFSET $2`,
      [Number(limit), offset]
    )
    return res.status(200).json({ data: rows })
  } catch (err) {
    console.error('[BOOKINGS] listBookings error:', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

module.exports = { createBooking, listBookings }
