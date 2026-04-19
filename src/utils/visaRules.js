/**
 * Visa eligibility lookup — static rules (replace with Sherpa/iVisa API in production)
 *
 * Result types:
 *   visa_free        — no visa needed
 *   visa_on_arrival  — obtain on arrival at airport
 *   e_visa           — apply online before travel
 *   visa_required    — full visa application required
 */

// ---------------------------------------------------------------------------
// Country groups for compact rule definitions
// ---------------------------------------------------------------------------
const EU = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU',
            'IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE']
const EEA    = [...EU, 'IS','LI','NO']
const STRONG = [...EEA, 'GB','US','CA','AU','NZ','JP','SG','KR','CH']

// ---------------------------------------------------------------------------
// Explicit corridor rules
// Format: rules[nationality][destination] = result
// Fallback: 'visa_required'
// ---------------------------------------------------------------------------
const RULES = {}

function set(nationalities, destinations, result) {
  for (const n of nationalities) {
    if (!RULES[n]) RULES[n] = {}
    for (const d of destinations) {
      RULES[n][d] = result
    }
  }
}

// EU/EEA free movement
set(EEA, EEA, 'visa_free')
set(EEA, ['GB'], 'visa_free')
set(['GB'], EEA, 'visa_free')

// Strong passports — United States
set(STRONG, ['US'], 'visa_free')
set(['US'], STRONG, 'visa_free')

// Strong passports — UAE
set(STRONG, ['AE'], 'visa_free')

// Strong passports — Thailand
set(STRONG, ['TH'], 'visa_on_arrival')

// Strong passports — Turkey
set([...EEA, 'GB'], ['TR'], 'visa_free')
set(['US','CA','AU','NZ'], ['TR'], 'e_visa')
set(['JP','KR','SG'], ['TR'], 'visa_free')

// Strong passports — Japan
set([...EEA, 'GB','US','CA','AU','NZ','SG','KR'], ['JP'], 'visa_free')

// Strong passports — Singapore
set(STRONG, ['SG'], 'visa_free')

// Strong passports — South Korea
set([...EEA, 'GB','US','CA','AU','NZ','JP','SG'], ['KR'], 'visa_free')

// Strong passports — Australia
set([...EEA, 'GB','US','CA','NZ','JP','SG','KR'], ['AU'], 'e_visa')

// Strong passports — UK
set([...EEA], ['GB'], 'visa_free')
set(['US','CA','AU','NZ','JP','SG','KR'], ['GB'], 'visa_free')

// Strong passports — Egypt
set(STRONG, ['EG'], 'visa_on_arrival')

// Strong passports — Morocco
set([...EEA, 'GB','US','CA','AU','NZ','JP','KR'], ['MA'], 'visa_free')

// Strong passports — Indonesia (Bali)
set(STRONG, ['ID'], 'visa_on_arrival')

// Strong passports — Vietnam
set([...EEA, 'GB','JP','KR'], ['VN'], 'visa_free')
set(['US','CA','AU','NZ'], ['VN'], 'e_visa')

// Strong passports — India
set(['JP'], ['IN'], 'visa_free')
set([...EEA, 'GB','US','CA','AU','NZ','SG','KR'], ['IN'], 'e_visa')

// Strong passports — China
set(['JP','SG'], ['CN'], 'visa_free')
set([...EEA, 'GB'], ['CN'], 'visa_free') // 144h transit / 15-day group; simplified here

// Turkish passport (TR) — common corridors
set(['TR'], [...EEA, 'GB'], 'visa_required')
set(['TR'], ['US'], 'visa_required')
set(['TR'], ['CA'], 'e_visa')
set(['TR'], ['AU'], 'e_visa')
set(['TR'], ['AE'], 'visa_on_arrival')
set(['TR'], ['TH'], 'visa_on_arrival')
set(['TR'], ['EG'], 'visa_on_arrival')
set(['TR'], ['MA'], 'visa_on_arrival')
set(['TR'], ['SG'], 'visa_required')
set(['TR'], ['JP'], 'visa_free')
set(['TR'], ['KR'], 'visa_free')
set(['TR'], ['ID'], 'visa_on_arrival')
set(['TR'], ['TR'], 'visa_free')
set(['TR'], ['AZ','GE','KZ','UZ'], 'visa_free')
set(['TR'], ['QA','OM','BH','KW'], 'visa_on_arrival')
set(['TR'], ['SA'], 'visa_on_arrival')

// Reciprocal: common destinations → Turkey
set([...EEA,'GB','US','CA','AU','NZ','JP','SG','KR'], ['QA'], 'visa_free')
set([...EEA,'GB','US','CA','AU','NZ'], ['SA'], 'e_visa')

// Self-travel is always visa_free
for (const iso2 of [...STRONG, 'TR','EG','MA','TH','ID','VN','IN','BR','AR','MX','ZA']) {
  if (!RULES[iso2]) RULES[iso2] = {}
  RULES[iso2][iso2] = 'visa_free'
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up visa requirement.
 * @param {string} nationality  - ISO 3166-1 alpha-2 (e.g. 'TR', 'DE')
 * @param {string} destination  - ISO 3166-1 alpha-2 (e.g. 'US', 'AE')
 * @returns {{ result: string, nationality: string, destination: string }}
 */
function checkVisa(nationality, destination) {
  const n = nationality?.toUpperCase()
  const d = destination?.toUpperCase()
  if (n === d) return { result: 'visa_free', nationality: n, destination: d }
  const result = RULES[n]?.[d] ?? 'visa_required'
  return { result, nationality: n, destination: d }
}

// IATA airport → ISO country code (extends the one in search.js)
const AIRPORT_TO_COUNTRY = {
  IST:'TR', SAW:'TR', ADB:'TR', ESB:'TR', AYT:'TR',
  LHR:'GB', LGW:'GB', MAN:'GB', STN:'GB', EDI:'GB',
  CDG:'FR', ORY:'FR', NCE:'FR', LYS:'FR',
  FRA:'DE', MUC:'DE', BER:'DE', HAM:'DE', DUS:'DE',
  MAD:'ES', BCN:'ES', AGP:'ES', PMI:'ES',
  FCO:'IT', MXP:'IT', VCE:'IT', NAP:'IT',
  AMS:'NL', BRU:'BE', ZRH:'CH', VIE:'AT',
  CPH:'DK', OSL:'NO', ARN:'SE', HEL:'FI',
  WAW:'PL', PRG:'CZ', BUD:'HU', BUH:'RO',
  JFK:'US', LAX:'US', ORD:'US', ATL:'US', DFW:'US', SFO:'US', MIA:'US', BOS:'US',
  YYZ:'CA', YVR:'CA', YUL:'CA',
  SYD:'AU', MEL:'AU', BNE:'AU', PER:'AU',
  AKL:'NZ', CHC:'NZ',
  NRT:'JP', HND:'JP', KIX:'JP',
  ICN:'KR', GMP:'KR',
  SIN:'SG',
  HKG:'HK',
  PVG:'CN', PEK:'CN', CAN:'CN',
  BOM:'IN', DEL:'IN', BLR:'IN', MAA:'IN',
  DXB:'AE', AUH:'AE', SHJ:'AE',
  DOH:'QA', AUH:'AE', BAH:'BH', MCT:'OM', KWI:'KW',
  RUH:'SA', JED:'SA', DMM:'SA',
  CAI:'EG', HRG:'EG', SSH:'EG',
  CMN:'MA', RAK:'MA', AGA:'MA',
  BKK:'TH', HKT:'TH', CNX:'TH',
  CGK:'ID', DPS:'ID', SUB:'ID',
  SGN:'VN', HAN:'VN', DAD:'VN',
  GRU:'BR', GIG:'BR', BSB:'BR',
  EZE:'AR', AEP:'AR',
  MEX:'MX', CUN:'MX',
  JNB:'ZA', CPT:'ZA',
  TBS:'GE', GYD:'AZ',
}

function iataToCountry(iata) {
  return AIRPORT_TO_COUNTRY[iata?.toUpperCase()] || null
}

module.exports = { checkVisa, iataToCountry }
