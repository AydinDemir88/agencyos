const pool                   = require('../config/db');
const { writeAudit }         = require('../utils/audit');
const { encrypt, decrypt, encryptIfProvided } = require('../utils/crypto');
const { buildPingAirShoppingRQ, buildAuthHeaders } = require('../utils/ndcBuilder');
const crypto                 = require('crypto');

// ---------------------------------------------------------------------------
// Safe columns returned to callers — all *_enc and iv_* columns are excluded
// ---------------------------------------------------------------------------
const PUBLIC_COLUMNS = `
  id, iata_code, airline_name, ndc_version, endpoint_url,
  auth_type, environment, credential_key,
  is_active, last_ping_at, last_ping_ms, last_ping_ok,
  created_by, created_at, updated_at
`;

/**
 * Transform a DB row into a safe API response object.
 * Credential columns are replaced with a boolean presence indicator.
 * This function is the single choke-point — credentials can never leak
 * through a missed column selection.
 */
function toPublicRecord(row) {
  return {
    id              : row.id,
    iata_code       : row.iata_code,
    airline_name    : row.airline_name,
    ndc_version     : row.ndc_version,
    endpoint_url    : row.endpoint_url,
    auth_type       : row.auth_type,
    environment     : row.environment,
    credential_key  : row.credential_key,
    is_active       : row.is_active,
    last_ping_at    : row.last_ping_at,
    last_ping_ms    : row.last_ping_ms,
    last_ping_ok    : row.last_ping_ok,
    has_api_key     : !!(row.api_key_enc),       // boolean only
    has_api_secret  : !!(row.api_secret_enc),    // boolean only
    has_access_token: !!(row.access_token_enc),  // boolean only
    created_by      : row.created_by,
    created_at      : row.created_at,
    updated_at      : row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// GET /ndc/airlines
// ---------------------------------------------------------------------------
async function listAirlines(req, res) {
  const { environment, is_active } = req.query;

  const conditions = [];
  const values     = [];

  if (environment) {
    values.push(environment);
    conditions.push(`environment = $${values.length}`);
  }

  if (is_active !== undefined) {
    values.push(is_active === 'true');
    conditions.push(`is_active = $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    // Fetch public columns + presence booleans — no *_enc columns ever selected
    const { rows } = await pool.query(
      `SELECT
         ${PUBLIC_COLUMNS},
         (api_key_enc    IS NOT NULL) AS api_key_enc,
         (api_secret_enc IS NOT NULL) AS api_secret_enc,
         (access_token_enc IS NOT NULL) AS access_token_enc
       FROM ndc_airline_configs
       ${where}
       ORDER BY airline_name ASC`,
      values
    );

    return res.status(200).json({ data: rows.map(toPublicRecord) });
  } catch (err) {
    console.error('[NDC] listAirlines error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// GET /ndc/airlines/:id
// ---------------------------------------------------------------------------
async function getAirline(req, res) {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT
         ${PUBLIC_COLUMNS},
         (api_key_enc    IS NOT NULL) AS api_key_enc,
         (api_secret_enc IS NOT NULL) AS api_secret_enc,
         (access_token_enc IS NOT NULL) AS access_token_enc
       FROM ndc_airline_configs
       WHERE id = $1
       LIMIT 1`,
      [id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Airline config not found' });

    return res.status(200).json({ data: toPublicRecord(rows[0]) });
  } catch (err) {
    console.error('[NDC] getAirline error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// POST /ndc/airlines
// ---------------------------------------------------------------------------
async function createAirline(req, res) {
  const caller = req.user;
  const ip     = req.ip;
  const ua     = req.headers['user-agent'] || null;

  const {
    iata_code, airline_name, ndc_version, endpoint_url,
    auth_type, environment, credential_key,
    api_key, api_secret,
  } = req.body;

  // Encrypt credentials — only if provided
  let apiKeyEnc = null, ivApiKey = null;
  let apiSecretEnc = null, ivApiSecret = null;

  try {
    if (api_key) {
      const result  = encrypt(api_key);
      apiKeyEnc     = result.ciphertext;
      ivApiKey      = result.iv;
    }
    if (api_secret) {
      const result  = encrypt(api_secret);
      apiSecretEnc  = result.ciphertext;
      ivApiSecret   = result.iv;
    }
  } catch (err) {
    console.error('[NDC] createAirline encryption error:', err.message);
    return res.status(500).json({ error: 'Credential encryption failed' });
  }

  let record;
  try {
    const { rows } = await pool.query(
      `INSERT INTO ndc_airline_configs (
         iata_code, airline_name, ndc_version, endpoint_url,
         auth_type, environment, credential_key,
         api_key_enc, iv_api_key,
         api_secret_enc, iv_api_secret,
         created_by
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING
         ${PUBLIC_COLUMNS},
         (api_key_enc    IS NOT NULL) AS api_key_enc,
         (api_secret_enc IS NOT NULL) AS api_secret_enc,
         (access_token_enc IS NOT NULL) AS access_token_enc`,
      [
        iata_code.toUpperCase(), airline_name, ndc_version || '21.3', endpoint_url,
        auth_type, environment, credential_key || null,
        apiKeyEnc, ivApiKey,
        apiSecretEnc, ivApiSecret,
        caller.id,
      ]
    );
    record = rows[0];
  } catch (err) {
    if (err.code === '23505') {   // unique_violation
      return res.status(409).json({ error: `Config for ${iata_code.toUpperCase()} in ${environment} already exists` });
    }
    console.error('[NDC] createAirline insert error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  await writeAudit({
    userId       : caller.id,
    action       : 'NDC_CONFIG_CREATE',
    resourceType : 'ndc_airline_config',
    resourceId   : record.id,
    ipAddress    : ip,
    userAgent    : ua,
    payload      : { iata_code, airline_name, auth_type, environment },
    result       : 'success',
  });

  return res.status(201).json({ data: toPublicRecord(record) });
}

// ---------------------------------------------------------------------------
// PATCH /ndc/airlines/:id
// ---------------------------------------------------------------------------
async function updateAirline(req, res) {
  const { id }  = req.params;
  const caller  = req.user;
  const ip      = req.ip;
  const ua      = req.headers['user-agent'] || null;

  // Fetch existing record (need encrypted values in case we're not changing them)
  let existing;
  try {
    const { rows } = await pool.query(
      `SELECT id, iata_code, environment,
              api_key_enc, iv_api_key,
              api_secret_enc, iv_api_secret
       FROM ndc_airline_configs WHERE id = $1 LIMIT 1`,
      [id]
    );
    existing = rows[0];
  } catch (err) {
    console.error('[NDC] updateAirline fetch error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!existing) return res.status(404).json({ error: 'Airline config not found' });

  const {
    airline_name, ndc_version, endpoint_url,
    auth_type, environment, credential_key, is_active,
    api_key, api_secret,
  } = req.body;

  // Re-encrypt credentials if new values provided, otherwise preserve existing
  let apiKeyResult, apiSecretResult;
  try {
    apiKeyResult    = encryptIfProvided(api_key,    existing.api_key_enc,    existing.iv_api_key);
    apiSecretResult = encryptIfProvided(api_secret, existing.api_secret_enc, existing.iv_api_secret);
  } catch (err) {
    console.error('[NDC] updateAirline encryption error:', err.message);
    return res.status(500).json({ error: 'Credential encryption failed' });
  }

  // Build dynamic SET clause
  const setClauses = [];
  const values     = [];

  const addField = (col, val) => {
    values.push(val);
    setClauses.push(`${col} = $${values.length}`);
  };

  if (airline_name   !== undefined) addField('airline_name',   airline_name);
  if (ndc_version    !== undefined) addField('ndc_version',    ndc_version);
  if (endpoint_url   !== undefined) addField('endpoint_url',   endpoint_url);
  if (auth_type      !== undefined) addField('auth_type',      auth_type);
  if (environment    !== undefined) addField('environment',    environment);
  if (credential_key !== undefined) addField('credential_key', credential_key);
  if (is_active      !== undefined) addField('is_active',      is_active);

  // Always write credential columns so a re-keying is atomic
  if (api_key !== undefined) {
    addField('api_key_enc', apiKeyResult.enc);
    addField('iv_api_key',  apiKeyResult.iv);
  }
  if (api_secret !== undefined) {
    addField('api_secret_enc', apiSecretResult.enc);
    addField('iv_api_secret',  apiSecretResult.iv);
  }

  if (setClauses.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  values.push(id);
  const idPlaceholder = `$${values.length}`;

  let updated;
  try {
    const { rows } = await pool.query(
      `UPDATE ndc_airline_configs
       SET    ${setClauses.join(', ')}, updated_at = NOW()
       WHERE  id = ${idPlaceholder}
       RETURNING
         ${PUBLIC_COLUMNS},
         (api_key_enc    IS NOT NULL) AS api_key_enc,
         (api_secret_enc IS NOT NULL) AS api_secret_enc,
         (access_token_enc IS NOT NULL) AS access_token_enc`,
      values
    );
    updated = rows[0];
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An config for this airline/environment combination already exists' });
    }
    console.error('[NDC] updateAirline update error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  await writeAudit({
    userId       : caller.id,
    action       : 'NDC_CONFIG_UPDATE',
    resourceType : 'ndc_airline_config',
    resourceId   : id,
    ipAddress    : ip,
    userAgent    : ua,
    payload      : { fields_updated: Object.keys(req.body).filter(k => !['api_key','api_secret'].includes(k)) },
    result       : 'success',
  });

  return res.status(200).json({ data: toPublicRecord(updated) });
}

// ---------------------------------------------------------------------------
// POST /ndc/airlines/:id/test
// ---------------------------------------------------------------------------
// Fires a lightweight NDC AirShopping ping.
// STUB: the actual HTTP call is replaced by a simulated response.
// When the real NDC integration is ready, replace the "STUB" block below
// with: const response = await axios.post(config.endpoint_url, xmlBody, { headers, timeout })
// then parse the XML response with fast-xml-parser.
// ---------------------------------------------------------------------------
async function testAirlinePing(req, res) {
  const { id }  = req.params;
  const caller  = req.user;
  const ip      = req.ip;
  const ua      = req.headers['user-agent'] || null;

  // Fetch config + encrypted credentials
  let config;
  try {
    const { rows } = await pool.query(
      `SELECT id, iata_code, airline_name, endpoint_url, auth_type, environment,
              api_key_enc, iv_api_key, api_secret_enc, iv_api_secret,
              access_token_enc, iv_access_token, is_active
       FROM ndc_airline_configs WHERE id = $1 LIMIT 1`,
      [id]
    );
    config = rows[0];
  } catch (err) {
    console.error('[NDC] testPing fetch error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!config) return res.status(404).json({ error: 'Airline config not found' });
  if (!config.is_active) return res.status(400).json({ error: 'Airline config is inactive' });

  // Decrypt credentials
  let credentials = {};
  try {
    if (config.api_key_enc && config.iv_api_key) {
      credentials.apiKey = decrypt(config.api_key_enc, config.iv_api_key);
    }
    if (config.api_secret_enc && config.iv_api_secret) {
      credentials.apiSecret = decrypt(config.api_secret_enc, config.iv_api_secret);
    }
    if (config.access_token_enc && config.iv_access_token) {
      credentials.accessToken = decrypt(config.access_token_enc, config.iv_access_token);
    }
  } catch (err) {
    console.error('[NDC] testPing decrypt error:', err.message);
    return res.status(500).json({ error: 'Failed to decrypt airline credentials' });
  }

  const correlationId = crypto.randomUUID();

  // Build NDC AirShopping RQ
  const xmlBody  = buildPingAirShoppingRQ({ iataCode: config.iata_code, correlationId });
  const { headers } = buildAuthHeaders(config.auth_type, credentials);

  // ---- STUB: replace this block with a real HTTP call in production -------
  console.log('[NDC_AIRSHOP_REQUEST]', {
    airline        : config.iata_code,
    environment    : config.environment,
    endpoint       : config.endpoint_url,
    correlationId,
    auth_type      : config.auth_type,
    // xmlBody logged only in non-production envs
    ...(process.env.NODE_ENV !== 'production' && { xml_preview: xmlBody.slice(0, 200) + '…' }),
  });

  // Simulated network round-trip (50–300 ms)
  const pingStart    = Date.now();
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 250) + 50));
  const pingMs       = Date.now() - pingStart;
  const pingOk       = true;
  const stubMessage  = `NDC AirShopping ping OK (stub) — replace with real HTTP call to ${config.endpoint_url}`;
  // ---- END STUB -----------------------------------------------------------

  // Persist ping results
  try {
    await pool.query(
      `UPDATE ndc_airline_configs
       SET last_ping_at = NOW(), last_ping_ms = $1, last_ping_ok = $2, updated_at = NOW()
       WHERE id = $3`,
      [pingMs, pingOk, id]
    );
  } catch (err) {
    console.error('[NDC] testPing update error:', err.message);
  }

  await writeAudit({
    userId       : caller.id,
    action       : 'NDC_PING',
    resourceType : 'ndc_airline_config',
    resourceId   : id,
    ipAddress    : ip,
    userAgent    : ua,
    payload      : { iata_code: config.iata_code, environment: config.environment, correlation_id: correlationId },
    result       : pingOk ? 'success' : 'failure',
  });

  return res.status(200).json({
    success          : pingOk,
    response_time_ms : pingMs,
    message          : stubMessage,
    airline          : config.iata_code,
    environment      : config.environment,
    correlation_id   : correlationId,
  });
}

module.exports = { listAirlines, getAirline, createAirline, updateAirline, testAirlinePing };
