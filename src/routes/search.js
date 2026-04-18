const express     = require('express');
const { z }       = require('zod');
const router      = express.Router();
const verifyToken = require('../middleware/verifyToken');
const validate    = require('../middleware/validate');
const ctrl        = require('../controllers/search');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const searchSchema = z.object({
  corporate_id     : z.string().uuid('corporate_id must be a valid UUID'),
  employee_id      : z.string().uuid().optional(),

  origin_iata      : z.string().length(3).toUpperCase()
                       .regex(/^[A-Z]{3}$/, 'origin_iata must be a 3-letter IATA code'),
  destination_iata : z.string().length(3).toUpperCase()
                       .regex(/^[A-Z]{3}$/, 'destination_iata must be a 3-letter IATA code'),

  departure_date   : z.string()
                       .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD format')
                       .refine(d => new Date(d) >= new Date(new Date().toDateString()), {
                         message: 'departure_date cannot be in the past',
                       }),

  return_date      : z.string()
                       .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD format')
                       .optional(),

  cabin_preference : z.enum(['economy', 'premium_economy', 'business', 'first']).optional(),

  pax_count        : z.number().int().min(1).max(9).default(1),
})
.refine(
  d => !d.return_date || new Date(d.return_date) > new Date(d.departure_date),
  { message: 'return_date must be after departure_date', path: ['return_date'] }
)
.refine(
  d => d.origin_iata !== d.destination_iata,
  { message: 'origin and destination cannot be the same', path: ['destination_iata'] }
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
router.use(verifyToken);

/**
 * POST /search/flights
 *
 * Queries all active NDC airlines, runs every offer through checkPolicy(),
 * and returns offers sorted: compliant first, then by price ascending.
 *
 * Access: all authenticated roles (consultants search on behalf of clients)
 */
router.post('/flights', validate(searchSchema), ctrl.searchFlights);

module.exports = router;
