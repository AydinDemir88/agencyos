const express     = require('express');
const { z }       = require('zod');
const router      = express.Router();
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const validate    = require('../middleware/validate');
const ctrl        = require('../controllers/ndc');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const createNdcSchema = z.object({
  iata_code      : z.string().length(2, 'IATA code must be exactly 2 characters').toUpperCase(),
  airline_name   : z.string().min(2).max(255).trim(),
  ndc_version    : z.string().max(10).default('21.3'),
  endpoint_url   : z.string().url().max(2048).startsWith('https://', 'Endpoint must use HTTPS'),
  auth_type      : z.enum(['API_KEY', 'OAUTH2', 'BASIC']),
  environment    : z.enum(['PRODUCTION', 'SANDBOX', 'TEST']),
  credential_key : z.string().max(255).trim().optional(),
  api_key        : z.string().min(1).max(512).optional(),
  api_secret     : z.string().min(1).max(512).optional(),
});

const updateNdcSchema = z.object({
  airline_name   : z.string().min(2).max(255).trim().optional(),
  ndc_version    : z.string().max(10).optional(),
  endpoint_url   : z.string().url().max(2048).startsWith('https://').optional(),
  auth_type      : z.enum(['API_KEY', 'OAUTH2', 'BASIC']).optional(),
  environment    : z.enum(['PRODUCTION', 'SANDBOX', 'TEST']).optional(),
  credential_key : z.string().max(255).trim().optional(),
  is_active      : z.boolean().optional(),
  api_key        : z.string().min(1).max(512).optional(),
  api_secret     : z.string().min(1).max(512).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field is required' });

const listQuerySchema = z.object({
  environment : z.enum(['PRODUCTION', 'SANDBOX', 'TEST']).optional(),
  is_active   : z.enum(['true', 'false']).optional(),
});

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        error  : 'Invalid query parameters',
        details: result.error.flatten().fieldErrors,
      });
    }
    req.query = result.data;
    next();
  };
}

// ---------------------------------------------------------------------------
// All NDC routes require authentication
// ---------------------------------------------------------------------------
router.use(verifyToken);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /ndc/airlines
 * List all airline configs. Credentials never returned.
 * Access: all authenticated roles (consultants need to know available airlines)
 */
router.get(
  '/',
  validateQuery(listQuerySchema),
  ctrl.listAirlines
);

/**
 * GET /ndc/airlines/:id
 * Get a single airline config. Credentials never returned.
 * Access: all authenticated roles
 */
router.get(
  '/:id',
  ctrl.getAirline
);

/**
 * POST /ndc/airlines
 * Create airline config. Encrypts api_key + api_secret before INSERT.
 * Access: SUPER_ADMIN, ADMIN
 */
router.post(
  '/',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  validate(createNdcSchema),
  ctrl.createAirline
);

/**
 * PATCH /ndc/airlines/:id
 * Update config. Re-encrypts credentials if new values provided.
 * Access: SUPER_ADMIN, ADMIN
 */
router.patch(
  '/:id',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  validate(updateNdcSchema),
  ctrl.updateAirline
);

/**
 * POST /ndc/airlines/:id/test
 * Fire a lightweight NDC AirShopping ping. Updates last_ping_* columns.
 * Access: SUPER_ADMIN, ADMIN
 */
router.post(
  '/:id/test',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  ctrl.testAirlinePing
);

module.exports = router;
