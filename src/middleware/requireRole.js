/**
 * requireRole — Express middleware factory
 *
 * Usage:
 *   router.get('/admin', verifyToken, requireRole('SUPER_ADMIN', 'ADMIN'), handler)
 *
 * Relies on verifyToken running first to populate req.user.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Forbidden. Required role: ${roles.join(' or ')}`,
      });
    }

    next();
  };
}

module.exports = requireRole;
