const jwt  = require('jsonwebtoken');
const pool = require('../config/db');

/**
 * verifyToken — Express middleware
 *
 * Validates the Bearer JWT from the Authorization header.
 * On success, attaches req.user = { id, name, email, role, status }.
 *
 * Performs a live DB lookup on every request so that deactivated or
 * role-changed users are rejected immediately without waiting for token expiry.
 */
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = authHeader.slice(7);

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'agencyos' });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Access token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid access token' });
  }

  // Live status check — catches deactivated users mid-session
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, status FROM users WHERE id = $1 LIMIT 1`,
      [payload.sub]
    );

    const user = rows[0];

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Account is not active' });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('[MIDDLEWARE] verifyToken DB error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = verifyToken;
