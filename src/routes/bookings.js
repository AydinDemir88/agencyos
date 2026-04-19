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
})
.refine(d => !d.policy_override || (d.policy_override && d.override_reason),
  { message: 'override_reason is required when policy_override is true', path: ['override_reason'] }
)

router.use(verifyToken)

router.post('/', validate(createBookingSchema), ctrl.createBooking)
router.get('/',  ctrl.listBookings)

module.exports = router
