const express     = require('express');
const { z }       = require('zod');
const router      = express.Router();
const verifyToken = require('../middleware/verifyToken');
const validate    = require('../middleware/validate');
const ctrl        = require('../controllers/search');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const multiCityLegSchema = z.object({
  origin_iata      : z.string().length(3).toUpperCase().regex(/^[A-Z]{3}$/),
  destination_iata : z.string().length(3).toUpperCase().regex(/^[A-Z]{3}$/),
  departure_date   : z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD format'),
}).refine(d => d.origin_iata !== d.destination_iata, {
  message: 'origin and destination cannot be the same',
  path: ['destination_iata'],
})

const searchSchema = z.object({
  corporate_id     : z.string().uuid('corporate_id must be a valid UUID'),
  employee_id      : z.string().uuid().optional(),

  trip_type        : z.enum(['one_way', 'return', 'multi_city']).default('one_way'),

  // Single-leg / return fields (required for one_way + return, optional for multi_city)
  origin_iata      : z.string().length(3).toUpperCase()
                       .regex(/^[A-Z]{3}$/, 'origin_iata must be a 3-letter IATA code').optional(),
  destination_iata : z.string().length(3).toUpperCase()
                       .regex(/^[A-Z]{3}$/, 'destination_iata must be a 3-letter IATA code').optional(),
  departure_date   : z.string()
                       .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD format')
                       .refine(d => new Date(d) >= new Date(new Date().toDateString()), {
                         message: 'departure_date cannot be in the past',
                       }).optional(),
  return_date      : z.string()
                       .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD format')
                       .optional(),

  // Multi-city legs
  multi_city_legs  : z.array(multiCityLegSchema).min(2).max(6).optional(),

  cabin_preference : z.enum(['economy', 'premium_economy', 'business', 'first']).optional(),

  // Pax breakdown
  pax_adults       : z.number().int().min(1).max(9).default(1),
  pax_children     : z.number().int().min(0).max(8).default(0),
  pax_infants      : z.number().int().min(0).max(4).default(0),

  // Frequent flyer
  frequent_flyer_airline : z.string().min(2).max(3).toUpperCase().optional(),
  frequent_flyer_number  : z.string().max(50).optional(),
})
.refine(
  d => d.trip_type === 'multi_city' || (d.origin_iata && d.destination_iata && d.departure_date),
  { message: 'origin_iata, destination_iata and departure_date are required for one_way/return trips', path: ['origin_iata'] }
)
.refine(
  d => d.trip_type !== 'multi_city' || (d.multi_city_legs && d.multi_city_legs.length >= 2),
  { message: 'multi_city_legs with at least 2 legs required for multi_city trips', path: ['multi_city_legs'] }
)
.refine(
  d => !d.return_date || !d.departure_date || new Date(d.return_date) > new Date(d.departure_date),
  { message: 'return_date must be after departure_date', path: ['return_date'] }
)
.refine(
  d => !d.origin_iata || !d.destination_iata || d.origin_iata !== d.destination_iata,
  { message: 'origin and destination cannot be the same', path: ['destination_iata'] }
)
.refine(
  d => (d.pax_adults + (d.pax_children || 0) + (d.pax_infants || 0)) <= 9,
  { message: 'Total passengers cannot exceed 9', path: ['pax_adults'] }
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
