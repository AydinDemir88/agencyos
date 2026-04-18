const express  = require('express');
const { z }    = require('zod');
const router   = express.Router();
const validate = require('../middleware/validate');
const { login, refresh, logout } = require('../controllers/auth');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const loginSchema = z.object({
  email    : z.string().email('Invalid email').max(255).toLowerCase().trim(),
  password : z.string().min(8, 'Password must be at least 8 characters').max(128),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /auth/login
 * Body: { email, password }
 * Returns: { access_token, token_type, expires_in, user }
 * Sets httpOnly refresh_token cookie
 */
router.post('/login', validate(loginSchema), login);

/**
 * POST /auth/refresh
 * Reads refresh_token from httpOnly cookie
 * Returns: { access_token, token_type, expires_in }
 * Rotates and re-sets the refresh_token cookie
 */
router.post('/refresh', refresh);

/**
 * POST /auth/logout
 * Reads refresh_token from httpOnly cookie
 * Revokes token in DB and clears cookie
 */
router.post('/logout', logout);

module.exports = router;
