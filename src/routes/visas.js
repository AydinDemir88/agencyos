const express     = require('express')
const { z }       = require('zod')
const router      = express.Router()
const verifyToken = require('../middleware/verifyToken')
const validate    = require('../middleware/validate')
const ctrl        = require('../controllers/visas')

const createVisaSchema = z.object({
  corporate_id         : z.string().uuid(),
  employee_id          : z.string().uuid(),
  booking_id           : z.string().uuid().optional(),
  origin_country       : z.string().length(2).toUpperCase(),
  dest_country         : z.string().length(2).toUpperCase(),
  travel_date          : z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  return_date          : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  visa_type            : z.enum(['TOURIST','BUSINESS','TRANSIT','STUDENT','WORK']).optional(),
  passport_number      : z.string().max(20).optional(),
  passport_nationality : z.string().length(2).toUpperCase().optional(),
  passport_expiry      : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  application_deadline : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes                : z.string().max(1000).optional(),
})

const updateVisaSchema = z.object({
  status           : z.enum(['draft','submitted','in_review','approved','rejected','expired']).optional(),
  reference_number : z.string().max(100).optional(),
  applied_at       : z.string().datetime().optional(),
  decision_at      : z.string().datetime().optional(),
  expiry_date      : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  application_deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes            : z.string().max(1000).optional(),
  visa_type        : z.enum(['TOURIST','BUSINESS','TRANSIT','STUDENT','WORK']).optional(),
  passport_number  : z.string().max(20).optional(),
  passport_nationality: z.string().length(2).toUpperCase().optional(),
  passport_expiry  : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  travel_date      : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  return_date      : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine(d => Object.keys(d).length > 0, { message: 'At least one field required' })

router.use(verifyToken)

router.get('/check',  ctrl.eligibilityCheck)
router.get('/stats',  ctrl.getStats)
router.get('/',       ctrl.listVisas)
router.post('/',      validate(createVisaSchema), ctrl.createVisa)
router.get('/:id',    ctrl.getVisa)
router.patch('/:id',  validate(updateVisaSchema), ctrl.updateVisa)
router.delete('/:id', ctrl.deleteVisa)

module.exports = router
