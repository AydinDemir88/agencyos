const express       = require('express');
const { z }         = require('zod');
const router        = express.Router();
const verifyToken   = require('../middleware/verifyToken');
const requireRole   = require('../middleware/requireRole');
const validate      = require('../middleware/validate');
const ctrl          = require('../controllers/users');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const createUserSchema = z.object({
  name     : z.string().min(2).max(255).trim(),
  email    : z.string().email().max(255).toLowerCase().trim(),
  password : z.string()
    .min(8,  'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(/[A-Z]/,      'Password must contain at least one uppercase letter')
    .regex(/[a-z]/,      'Password must contain at least one lowercase letter')
    .regex(/[0-9]/,      'Password must contain at least one number')
    .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
  role     : z.enum(['SUPER_ADMIN', 'ADMIN', 'CONSULTANT', 'SUB_AGENT']),
});

const updateUserSchema = z.object({
  name   : z.string().min(2).max(255).trim().optional(),
  role   : z.enum(['SUPER_ADMIN', 'ADMIN', 'CONSULTANT', 'SUB_AGENT']).optional(),
  status : z.enum(['active', 'inactive', 'locked', 'pending_verification']).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field is required' });

const listQuerySchema = z.object({
  page   : z.coerce.number().int().min(1).default(1),
  limit  : z.coerce.number().int().min(1).max(100).default(20),
  role   : z.enum(['SUPER_ADMIN', 'ADMIN', 'CONSULTANT', 'SUB_AGENT']).optional(),
  status : z.enum(['active', 'inactive', 'locked', 'pending_verification']).optional(),
  search : z.string().max(100).trim().optional(),
});

// Query validator (reads from req.query, not req.body)
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
// All user routes require authentication
// ---------------------------------------------------------------------------
router.use(verifyToken);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /users
 * List users with optional filters.
 * Access: SUPER_ADMIN, ADMIN
 */
router.get(
  '/',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  validateQuery(listQuerySchema),
  ctrl.listUsers
);

/**
 * POST /users
 * Create a new user. Hashes password. Logs to audit_logs.
 * Access: SUPER_ADMIN, ADMIN
 * Rule: only SUPER_ADMIN may assign the SUPER_ADMIN role.
 */
router.post(
  '/',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  validate(createUserSchema),
  ctrl.createUser
);

/**
 * PATCH /users/:id
 * Update name, role, or status.
 * Access: SUPER_ADMIN, ADMIN
 * Rules:
 *   - Only SUPER_ADMIN may assign or modify a SUPER_ADMIN user.
 *   - A user cannot change their own role.
 */
router.patch(
  '/:id',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  validate(updateUserSchema),
  ctrl.updateUser
);

/**
 * DELETE /users/:id
 * Soft-delete: sets status = 'inactive'.
 * Access: SUPER_ADMIN, ADMIN
 * Rules:
 *   - Cannot soft-delete a SUPER_ADMIN.
 *   - Cannot soft-delete yourself.
 */
router.delete(
  '/:id',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  ctrl.deleteUser
);

module.exports = router;
