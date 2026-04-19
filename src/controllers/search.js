const pool           = require('../config/db');
const { writeAudit } = require('../utils/audit');
const { decrypt }    = require('../utils/crypto');
const { buildPingAirShoppingRQ, buildAuthHeaders, parseMockAirShoppingRS } = require('../utils/ndcBuilder');
const { checkPolicy }= require('../utils/policyEngine');
const crypto         = require('crypto');

// ---------------------------------------------------------------------------
// Domestic route detection
// ---------------------------------------------------------------------------
// Simple heuristic: a curated map of IATA airport codes → ISO country code.
// In production, replace with a full airport database table or an external API.
const AIRPORT_COUNTRY = {
  // Turkey
  IST: 'TR', SAW: 'TR', ADB: 'TR', ESB: 'TR', AYT: 'TR', DLM: 'TR', BJV: 'TR',
  // United Kingdom
  LHR: 'GB', LGW: 'GB', MAN: 'GB', STN: 'GB', BHX: 'GB', EDI: 'GB',
  // Germany
  FRA: 'DE', MUC: 'DE', TXL: 'DE', BER: 'DE', HAM: 'DE', DUS: 'DE',
  // USA
  JFK: 'US', LAX: 'US', ORD: 'US', ATL: 'US', DFW: 'US', SFO: 'US', MIA: 'US',
  // UAE
  DXB: 'AE', AUH: 'AE',
  // France
  CDG: 'FR', ORY: 'FR',
  // Netherlands
  AMS: 'NL',
  // Spain
  MAD: 'ES', BCN: 'ES',
  // Italy
  FCO: 'IT', MXP: 'IT',
  // Singapore
  SIN: 'SG',
  // Japan
  NRT: 'JP', HND: 'JP', KIX: 'JP',
  // Hong Kong
  HKG: 'HK',
};

function isDomesticRoute(origin, destination) {
  const originCountry = AIRPORT_COUNTRY[origin?.toUpperCase()];
  const destCountry   = AIRPORT_COUNTRY[destination?.toUpperCase()];
  if (!originCountry || !destCountry) return false;   // unknown → treat as international
  return originCountry === destCountry;
}

// ---------------------------------------------------------------------------
// NDC AirShopping call (stub — replace HTTP block when going live)
// ---------------------------------------------------------------------------
async function callNdcAirShopping({ config, origin, destination, departureDate, paxCount }) {
  const correlationId = crypto.randomUUID();

  // Decrypt credentials for this airline
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
    console.error(`[SEARCH] Credential decrypt failed for ${config.iata_code}:`, err.message);
    return { offers: [], error: 'credential_error', correlationId };
  }

  // Build request artifacts (used by real integration)
  const xmlBody         = buildPingAirShoppingRQ({ iataCode: config.iata_code, correlationId });
  const { headers }     = buildAuthHeaders(config.auth_type, credentials);
  const requestStart    = Date.now();

  // ---- STUB: replace everything below this comment with a real axios call ----
  // Real implementation:
  //   const response = await axios.post(config.endpoint_url, xmlBody, {
  //     headers,
  //     timeout: parseInt(process.env.NDC_REQUEST_TIMEOUT_MS || '10000', 10),
  //   });
  //   const offers = parseAirShoppingRS(response.data);   // fast-xml-parser
  //   return { offers, correlationId, responseTimeMs: Date.now() - requestStart };

  console.log('[NDC_AIRSHOP_REQUEST]', {
    correlation_id : correlationId,
    airline        : config.iata_code,
    environment    : config.environment,
    endpoint       : config.endpoint_url,
    origin,
    destination,
    departure_date : departureDate,
    pax_count      : paxCount,
    ...(process.env.NODE_ENV !== 'production' && { xml_preview: xmlBody.slice(0, 150) + '…' }),
  });

  // Simulated latency
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 180) + 40));

  const offers = parseMockAirShoppingRS(config.iata_code, origin, destination, departureDate);
  // ---- END STUB ---------------------------------------------------------------

  return {
    offers,
    correlationId,
    responseTimeMs: Date.now() - requestStart,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// POST /search/flights
// ---------------------------------------------------------------------------
async function searchFlights(req, res) {
  const caller = req.user;
  const ip     = req.ip;
  const ua     = req.headers['user-agent'] || null;

  const {
    corporate_id,
    employee_id,
    origin_iata,
    destination_iata,
    departure_date,
    return_date,
    cabin_preference,
    pax_count = 1,
  } = req.body;

  // ------------------------------------------------------------------
  // 1. Validate corporate exists and is active
  // ------------------------------------------------------------------
  let corporate;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, status, currency FROM corporates WHERE id = $1 LIMIT 1`,
      [corporate_id]
    );
    corporate = rows[0];
  } catch (err) {
    console.error('[SEARCH] corporate lookup error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!corporate) return res.status(404).json({ error: 'Corporate not found' });
  if (corporate.status !== 'active') {
    return res.status(400).json({ error: 'Corporate account is not active' });
  }

  // ------------------------------------------------------------------
  // 2. Validate employee belongs to this corporate
  // ------------------------------------------------------------------
  if (employee_id) {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, cabin_tier FROM corporate_employees
         WHERE id = $1 AND corporate_id = $2 AND status = 'active' LIMIT 1`,
        [employee_id, corporate_id]
      );
      if (!rows[0]) {
        return res.status(404).json({ error: 'Employee not found or inactive for this corporate' });
      }
    } catch (err) {
      console.error('[SEARCH] employee lookup error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // ------------------------------------------------------------------
  // 3. Load travel policy for this corporate
  // ------------------------------------------------------------------
  let policy = null;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM corporate_travel_policies WHERE corporate_id = $1 LIMIT 1`,
      [corporate_id]
    );
    policy = rows[0] || null;
  } catch (err) {
    console.error('[SEARCH] policy lookup error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // ------------------------------------------------------------------
  // 4. Load active NDC airline configs (with credential columns)
  // ------------------------------------------------------------------
  let airlineConfigs;
  try {
    const { rows } = await pool.query(
      `SELECT id, iata_code, airline_name, endpoint_url, auth_type, environment,
              api_key_enc, iv_api_key, api_secret_enc, iv_api_secret,
              access_token_enc, iv_access_token
       FROM   ndc_airline_configs
       WHERE  is_active = true
         AND  environment = $1`,
      [process.env.NDC_ENVIRONMENT || (process.env.NODE_ENV === 'production' ? 'PRODUCTION' : 'SANDBOX')]
    );
    airlineConfigs = rows;
  } catch (err) {
    console.error('[SEARCH] airline config lookup error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (airlineConfigs.length === 0) {
    return res.status(503).json({ error: 'No active airlines configured for this environment' });
  }

  // ------------------------------------------------------------------
  // 5. Fire NDC AirShopping on all active airlines (parallel)
  // ------------------------------------------------------------------
  const domestic       = isDomesticRoute(origin_iata, destination_iata);
  const searchResults  = await Promise.allSettled(
    airlineConfigs.map(config =>
      callNdcAirShopping({
        config,
        origin         : origin_iata,
        destination    : destination_iata,
        departureDate  : departure_date,
        paxCount       : pax_count,
      })
    )
  );

  // ------------------------------------------------------------------
  // 6. Flatten offers + stamp each with policy_status
  // ------------------------------------------------------------------
  const allOffers    = [];
  const airlineErrors = [];

  for (const result of searchResults) {
    if (result.status === 'rejected') {
      airlineErrors.push({ error: result.reason?.message || 'unknown' });
      continue;
    }

    const { offers, error, correlationId } = result.value;

    if (error) {
      airlineErrors.push({ correlationId, error });
      continue;
    }

    for (const offer of offers) {
      const policyStatus = checkPolicy(
        {
          cabinClass          : offer.cabinClass,
          totalAmountCents    : offer.totalCents,
          baseFareCents       : offer.baseFareCents,
          isRefundable        : offer.isRefundable,
          isDomestic          : domestic,
          flightDurationHours : offer.flightDurationHours,
          departureAt         : offer.departureAt,
        },
        policy
      );

      allOffers.push({
        ...offer,
        policy_status: policyStatus,
      });
    }
  }

  // Sort: compliant offers first, then by total price ascending
  allOffers.sort((a, b) => {
    if (a.policy_status.compliant !== b.policy_status.compliant) {
      return a.policy_status.compliant ? -1 : 1;
    }
    return a.totalCents - b.totalCents;
  });

  // ------------------------------------------------------------------
  // 7. Audit log
  // ------------------------------------------------------------------
  await writeAudit({
    userId       : caller.id,
    action       : 'FLIGHT_SEARCH',
    resourceType : 'corporate',
    resourceId   : corporate_id,
    ipAddress    : ip,
    userAgent    : ua,
    payload      : {
      origin_iata,
      destination_iata,
      departure_date,
      return_date       : return_date || null,
      pax_count,
      airlines_queried  : airlineConfigs.length,
      offers_returned   : allOffers.length,
      compliant_offers  : allOffers.filter(o => o.policy_status.compliant).length,
    },
    result: 'success',
  });

  return res.status(200).json({
    data: {
      search_context: {
        corporate_id,
        employee_id    : employee_id || null,
        origin_iata,
        destination_iata,
        departure_date,
        return_date    : return_date || null,
        is_domestic    : domestic,
        pax_count,
        policy_active  : !!policy,
        currency       : corporate.currency,
      },
      offers     : allOffers,
      meta: {
        total_offers     : allOffers.length,
        compliant_offers : allOffers.filter(o => o.policy_status.compliant).length,
        airlines_queried : airlineConfigs.length,
        airlines_failed  : airlineErrors.length,
      },
      ...(airlineErrors.length > 0 && { airline_errors: airlineErrors }),
    },
  });
}

module.exports = { searchFlights };
