/**
 * NDC Request Builder — IATA NDC 21.3
 *
 * Produces well-formed NDC XML request envelopes.
 * The stub NDC ping uses a minimal AirShopping RQ.
 * When the real NDC integration is wired in, replace the stub HTTP call
 * in controllers/ndc.js with an actual axios/fetch call using the
 * XML generated here.
 *
 * Data contract expected by the real integration:
 *   buildAirShoppingRQ(params) → XML string
 *   parseAirShoppingRS(xmlString) → { offers: Offer[], errors: NDCError[] }
 */

const crypto = require('crypto');

/**
 * Build a minimal NDC 21.3 AirShopping RQ for a health ping.
 * Uses a one-way search 14 days from today on a fixed route.
 *
 * @param {Object} params
 * @param {string} params.iataCode     - Airline IATA code (e.g. 'TK')
 * @param {string} params.correlationId - Unique request ID for tracing
 * @returns {string} XML string
 */
function buildPingAirShoppingRQ({ iataCode, correlationId }) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 14);
  const depDate = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD

  return `<?xml version="1.0" encoding="UTF-8"?>
<AirShoppingRQ xmlns="http://www.iata.org/IATA/EDIST/2017.2"
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               Version="21.3"
               TransactionIdentifier="${correlationId}">
  <PointOfSale>
    <Location>
      <CountryCode>TR</CountryCode>
    </Location>
    <RequestTime>${new Date().toISOString()}</RequestTime>
  </PointOfSale>
  <Document>
    <Name>AgencyOS NDC Client</Name>
    <ReferenceVersion>1.0</ReferenceVersion>
  </Document>
  <Party>
    <Sender>
      <TravelAgencySender>
        <AgencyID>AGENCYOS</AgencyID>
      </TravelAgencySender>
    </Sender>
    <Recipients>
      <AirlineRecipient>
        <AirlineDesigCode>${iataCode}</AirlineDesigCode>
      </AirlineRecipient>
    </Recipients>
  </Party>
  <CoreQuery>
    <OriginDestinations>
      <OriginDestination>
        <Departure>
          <AirportCode>IST</AirportCode>
          <Date>${depDate}</Date>
        </Departure>
        <Arrival>
          <AirportCode>LHR</AirportCode>
        </Arrival>
      </OriginDestination>
    </OriginDestinations>
  </CoreQuery>
  <Preference>
    <AirlinePreferences>
      <Airline>
        <AirlineDesigCode>${iataCode}</AirlineDesigCode>
      </Airline>
    </AirlinePreferences>
    <CabinPreferences>
      <CabinType>
        <Code>Y</Code>
      </CabinType>
    </CabinPreferences>
  </Preference>
  <DataLists>
    <PassengerList>
      <Passenger PassengerID="PAX1">
        <PTC>ADT</PTC>
      </Passenger>
    </PassengerList>
  </DataLists>
</AirShoppingRQ>`;
}

/**
 * Build Authorization header value based on auth_type.
 *
 * @param {'API_KEY'|'OAUTH2'|'BASIC'} authType
 * @param {{ apiKey?: string, apiSecret?: string, accessToken?: string }} credentials
 * @returns {{ headers: Object }}
 */
function buildAuthHeaders(authType, credentials) {
  switch (authType) {
    case 'API_KEY':
      return {
        headers: {
          'X-Api-Key'    : credentials.apiKey,
          'Content-Type' : 'application/xml',
        },
      };
    case 'OAUTH2':
      return {
        headers: {
          'Authorization': `Bearer ${credentials.accessToken}`,
          'Content-Type' : 'application/xml',
        },
      };
    case 'BASIC': {
      const encoded = Buffer.from(`${credentials.apiKey}:${credentials.apiSecret}`).toString('base64');
      return {
        headers: {
          'Authorization': `Basic ${encoded}`,
          'Content-Type' : 'application/xml',
        },
      };
    }
    default:
      throw new Error(`Unknown auth_type: ${authType}`);
  }
}

/**
 * Parse a stub/mock NDC AirShopping RS into the internal offer format.
 * Replace this with real XML parsing (fast-xml-parser or xml2js) when
 * wiring up the live NDC integration.
 *
 * Internal offer shape (used by checkPolicy() and search results):
 * {
 *   offerId       : string,
 *   airlineCode   : string,
 *   origin        : string,   // IATA
 *   destination   : string,   // IATA
 *   departureAt   : string,   // ISO 8601
 *   arrivalAt     : string,   // ISO 8601
 *   cabinClass    : string,
 *   fareBrand     : string,
 *   baseFareCents : number,
 *   taxesCents    : number,
 *   totalCents    : number,
 *   currency      : string,
 *   isRefundable  : boolean,
 *   flightDurationHours: number,
 *   ndcOfferItemId: string,
 * }
 */
function parseMockAirShoppingRS(iataCode, origin, destination, depDate) {
  // Deterministic mock — real parser replaces this entire function
  return [
    {
      offerId            : crypto.randomUUID(),
      airlineCode        : iataCode,
      origin,
      destination,
      departureAt        : `${depDate}T08:00:00Z`,
      arrivalAt          : `${depDate}T10:30:00Z`,
      cabinClass         : 'economy',
      fareBrand          : 'ECONOMY_SAVER',
      baseFareCents      : 45000,
      taxesCents         : 8500,
      totalCents         : 53500,
      currency           : 'USD',
      isRefundable       : false,
      flightDurationHours: 2.5,
      ndcOfferItemId     : crypto.randomUUID(),
    },
    {
      offerId            : crypto.randomUUID(),
      airlineCode        : iataCode,
      origin,
      destination,
      departureAt        : `${depDate}T14:00:00Z`,
      arrivalAt          : `${depDate}T16:30:00Z`,
      cabinClass         : 'business',
      fareBrand          : 'BUSINESS_FLEX',
      baseFareCents      : 185000,
      taxesCents         : 22000,
      totalCents         : 207000,
      currency           : 'USD',
      isRefundable       : true,
      flightDurationHours: 2.5,
      ndcOfferItemId     : crypto.randomUUID(),
    },
  ];
}

module.exports = { buildPingAirShoppingRQ, buildAuthHeaders, parseMockAirShoppingRS };
