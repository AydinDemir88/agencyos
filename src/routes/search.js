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
// NDC follow-up step schemas
// ---------------------------------------------------------------------------
const cabinEnum = z.enum(['economy','premium_economy','business','first']);

const offerPriceSchema = z.object({
  offerId       : z.string().min(1),
  totalCents    : z.number().int().min(0),
  baseFareCents : z.number().int().min(0),
  taxesCents    : z.number().int().min(0),
  currency      : z.string().length(3).toUpperCase(),
  cabinClass    : cabinEnum,
  airlineCode   : z.string().min(2).max(3),
  origin        : z.string().length(3).toUpperCase(),
  destination   : z.string().length(3).toUpperCase(),
})

const serviceListSchema = z.object({
  pricedOfferId : z.string().min(1),
  airlineCode   : z.string().min(2).max(3),
  cabinClass    : cabinEnum,
})

const seatAvailSchema = z.object({
  pricedOfferId : z.string().min(1),
  airlineCode   : z.string().min(2).max(3),
  cabinClass    : cabinEnum,
  origin        : z.string().length(3).toUpperCase(),
  destination   : z.string().length(3).toUpperCase(),
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
router.use(verifyToken);

router.post('/flights',           validate(searchSchema),     ctrl.searchFlights);
router.post('/offer-price',       validate(offerPriceSchema), ctrl.offerPrice);
router.post('/service-list',      validate(serviceListSchema),ctrl.serviceList);
router.post('/seat-availability', validate(seatAvailSchema),  ctrl.seatAvailability);

module.exports = router;
