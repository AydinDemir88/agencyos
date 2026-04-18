const crypto = require('crypto');
const pool = require('../config/db');

/**
 * Write an entry to audit_logs.
 *
 * @param {Object}  params
 * @param {string|null}  params.userId        - UUID of acting user (null for anonymous)
 * @param {string}       params.action        - Uppercase snake_case event name, e.g. 'USER_LOGIN'
 * @param {string|null}  params.resourceType  - e.g. 'user', 'booking', 'corporate'
 * @param {string|null}  params.resourceId    - UUID or string PK of the affected row
 * @param {string|null}  params.ipAddress     - req.ip
 * @param {string|null}  params.userAgent     - req.headers['user-agent']
 * @param {Object|null}  params.payload       - Sanitised request body (NO passwords, NO tokens)
 * @param {'success'|'failure'|'error'} params.result
 */
async function writeAudit({
  userId       = null,
  action,
  resourceType = null,
  resourceId   = null,
  ipAddress    = null,
  userAgent    = null,
  payload      = null,
  result,
}) {
  const payloadHash = payload
    ? crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    : null;

  try {
    await pool.query(
      `INSERT INTO audit_logs
         (user_id, action, resource_type, resource_id, ip_address, user_agent, payload_hash, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, action, resourceType, resourceId, ipAddress, userAgent, payloadHash, result]
    );
  } catch (err) {
    // Audit failures must never crash the request — log and continue
    console.error('[AUDIT] Failed to write audit log:', err.message);
  }
}

module.exports = { writeAudit };
