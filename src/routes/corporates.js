const express     = require('express');
const { z }       = require('zod');
const router      = express.Router();
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const validate    = require('../middleware/validate');
const ctrl        = require('../controllers/corporates');

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------
const addressSchema = z.object({
  street  : z.string().max(255).optional(),
  city    : z.string().max(100).optional(),
  country : z.string().max(100).optional(),
  zip     : z.string().max(20).optional(),
}).optional();

const passportSchema = z.object({
  number      : z.string().max(20),
  nationality : z.string().length(2).toUpperCase(),   // ISO 3166-1 alpha-2
  dob         : z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  expiry      : z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  given_name  : z.string().max(100),
  surname     : z.string().max(100),
}).optional();

// ---------------------------------------------------------------------------
// Corporate schemas
// ---------------------------------------------------------------------------
const createCorporateSchema = z.object({
  name             : z.string().min(2).max(255).trim(),
  tax_id           : z.string().min(2).max(50).trim(),
  sector           : z.string().max(100).optional(),
  employee_count   : z.number().int().positive().optional(),
  contact_email    : z.string().email().max(255).toLowerCase(),
  contact_phone    : z.string().max(50).optional(),
  address          : addressSchema,
  coordinator_name : z.string().max(255).optional(),
  contract_start   : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  contract_end     : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  service_fee_type  : z.enum(['FLAT', 'PERCENTAGE']).default('FLAT'),
  service_fee_amount: z.number().int().min(0).default(0),
  credit_limit      : z.number().int().min(0).default(0),
  currency          : z.string().length(3).toUpperCase().default('USD'),
  payment_term_days : z.number().int().positive().default(30),
  status            : z.enum(['active','inactive','suspended','prospect']).default('active'),
  notes             : z.string().max(2000).optional(),
  payment_method    : z.enum(['INVOICE','CREDIT_CARD','PREPAID']).default('INVOICE'),
  payment_card_last4: z.string().length(4).optional(),
  payment_card_brand: z.string().max(20).optional(),
  payment_card_expiry: z.string().max(7).optional(),
  payment_notes     : z.string().max(500).optional(),
});

const updateCorporateSchema = createCorporateSchema
  .partial()
  .refine(d => Object.keys(d).length > 0, { message: 'At least one field required' });

// ---------------------------------------------------------------------------
// Employee schemas
// ---------------------------------------------------------------------------
const frequentFlyerSchema = z.object({
  airline_code : z.string().min(2).max(3).toUpperCase(),
  number       : z.string().min(1).max(50),
  tier         : z.string().max(50).optional(),   // e.g. Gold, Platinum, Miles&More
}).strict()

const preferencesSchema = z.object({
  seat               : z.enum(['window','aisle','middle','no_preference']).optional(),
  meal               : z.enum(['standard','vegetarian','vegan','halal','kosher','gluten_free','low_calorie','no_preference']).optional(),
  special_assistance : z.boolean().optional(),
  notes              : z.string().max(500).optional(),
}).optional()

const createEmployeeSchema = z.object({
  name            : z.string().min(2).max(255).trim(),
  title           : z.string().max(100).optional(),
  department      : z.string().max(100).optional(),
  email           : z.string().email().max(255).toLowerCase(),
  phone           : z.string().max(50).optional(),
  employee_number : z.string().max(50).optional(),
  cost_center     : z.string().max(100).optional(),
  nationality     : z.string().length(2).toUpperCase().optional(),
  date_of_birth   : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  passport        : passportSchema,
  cabin_tier      : z.enum(['economy','premium_economy','business','first']).optional(),
  frequent_flyers : z.array(frequentFlyerSchema).max(10).optional(),
  preferences     : preferencesSchema,
});

const updateEmployeeSchema = createEmployeeSchema
  .partial()
  .extend({ status: z.enum(['active','inactive','on_leave']).optional() })
  .refine(d => Object.keys(d).length > 0, { message: 'At least one field required' });

const importEmployeeSchema = z.object({
  employees: z.array(createEmployeeSchema).min(1).max(500),
});

// ---------------------------------------------------------------------------
// Policy schema
// ---------------------------------------------------------------------------
const upsertPolicySchema = z.object({
  domestic_cabin             : z.enum(['economy','premium_economy','business','first']).default('economy'),
  intl_short_cabin           : z.enum(['economy','premium_economy','business','first']).default('economy'),
  intl_long_cabin            : z.enum(['economy','premium_economy','business','first']).default('business'),
  long_haul_threshold_hours  : z.number().int().positive().default(4),
  max_domestic_fare          : z.number().int().positive().nullable().optional(),
  max_intl_fare              : z.number().int().positive().nullable().optional(),
  max_hotel_per_night        : z.number().int().positive().nullable().optional(),
  min_advance_days           : z.number().int().min(0).default(3),
  require_refundable_above   : z.number().int().positive().nullable().optional(),
  require_approval_above     : z.number().int().positive().nullable().optional(),
  approver_user_id           : z.string().uuid().nullable().optional(),
  effective_from             : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effective_to               : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Query validator
// ---------------------------------------------------------------------------
const listQuerySchema = z.object({
  page        : z.coerce.number().int().min(1).default(1),
  limit       : z.coerce.number().int().min(1).max(100).default(20),
  status      : z.string().optional(),
  search      : z.string().max(100).optional(),
  employee_id : z.string().uuid().optional(),
  from        : z.string().optional(),
  to          : z.string().optional(),
});

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: result.error.flatten().fieldErrors });
    }
    req.query = result.data;
    next();
  };
}

// ---------------------------------------------------------------------------
// All routes require authentication
// ---------------------------------------------------------------------------
router.use(verifyToken);

// ===========================================================================
// CORPORATE CRUD
// ===========================================================================

router.get(   '/',    validateQuery(listQuerySchema), ctrl.listCorporates);
router.get(   '/:id', ctrl.getCorporate);

router.post(  '/',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  validate(createCorporateSchema),
  ctrl.createCorporate
);

router.patch( '/:id',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  validate(updateCorporateSchema),
  ctrl.updateCorporate
);

router.delete('/:id',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  ctrl.deleteCorporate
);

// ===========================================================================
// EMPLOYEES
// ===========================================================================

router.get(   '/:id/employees',
  validateQuery(listQuerySchema),
  ctrl.listEmployees
);

router.get(   '/:id/employees/:eid',
  ctrl.getEmployee
);

router.post(  '/:id/employees',
  requireRole('SUPER_ADMIN', 'ADMIN', 'CONSULTANT'),
  validate(createEmployeeSchema),
  ctrl.createEmployee
);

router.patch( '/:id/employees/:eid',
  requireRole('SUPER_ADMIN', 'ADMIN', 'CONSULTANT'),
  validate(updateEmployeeSchema),
  ctrl.updateEmployee
);

router.delete('/:id/employees/:eid',
  requireRole('SUPER_ADMIN', 'ADMIN', 'CONSULTANT'),
  ctrl.deleteEmployee
);

router.post(  '/:id/employees/import',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  validate(importEmployeeSchema),
  ctrl.importEmployees
);

// ===========================================================================
// TRAVEL POLICY
// ===========================================================================

router.get('/:id/policy', ctrl.getPolicy);

router.put( '/:id/policy',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  validate(upsertPolicySchema),
  ctrl.upsertPolicy
);

// ===========================================================================
// FINANCIAL SUMMARY
// ===========================================================================

router.get('/:id/financial',
  requireRole('SUPER_ADMIN', 'ADMIN', 'CONSULTANT'),
  ctrl.getFinancial
);

// ===========================================================================
// BOOKINGS (read-only — writes go through /bookings)
// ===========================================================================

router.get('/:id/bookings',
  validateQuery(listQuerySchema),
  ctrl.listCorporateBookings
);

module.exports = router;
