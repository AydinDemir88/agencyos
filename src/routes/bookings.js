const express     = require('express')
const { z }       = require('zod')
const router      = express.Router()
const verifyToken = require('../middleware/verifyToken')
const validate    = require('../middleware/validate')
const ctrl        = require('../controllers/bookings')

const createBookingSchema = z.object({
  corporate_id      : z.string().uuid(),
  employee_id       : z.string().uuid(),
  airline_config_id : z.string().uuid().optional(),
  origin_iata       : z.string().length(3).toUpperCase(),
  dest_iata         : z.string().length(3).toUpperCase(),
  departure_at      : z.string().datetime(),
  arrival_at        : z.string().datetime(),
  cabin_class       : z.enum(['economy','premium_economy','business','first']),
  fare_brand        : z.string().optional(),
  base_fare         : z.number().int().min(0),
  taxes             : z.number().int().min(0),
  service_fee       : z.number().int().min(0).default(0),
  total_amount      : z.number().int().min(0),
  currency          : z.string().length(3).toUpperCase().default('USD'),
  in_policy         : z.boolean(),
  policy_override   : z.boolean().default(false),
  override_reason   : z.string().min(10).optional(),
  ndc_offer_id      : z.string().optional(),
  selected_seat     : z.string().max(10).optional(),
  selected_services : z.array(z.object({
    serviceId   : z.string(),
    type        : z.string(),
    code        : z.string().optional(),
    description : z.string(),
    priceCents  : z.number().int().min(0),
  })).optional().default([]),
})
.refine(d => !d.policy_override || (d.policy_override && d.override_reason),
  { message: 'override_reason is required when policy_override is true', path: ['override_reason'] }
)

const serviceSchema = z.object({
  action      : z.enum(['void', 'refund', 'payment']),
  reason      : z.string().min(3).optional(),
  payment_ref : z.string().max(100).optional(),
})
.refine(d => d.action !== 'void'    || !!d.reason, { message: 'reason required for void',    path: ['reason'] })
.refine(d => d.action !== 'refund'  || !!d.reason, { message: 'reason required for refund',  path: ['reason'] })

router.use(verifyToken)

router.get( '/stats', ctrl.getStats)
router.post('/',      validate(createBookingSchema), ctrl.createBooking)
router.get( '/',      ctrl.listBookings)
router.get( '/:id',   ctrl.getBooking)
router.patch('/:id',  validate(serviceSchema), ctrl.serviceBooking)

module.exports = router
