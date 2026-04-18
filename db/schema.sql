-- =============================================================================
-- AgencyOS — Module 1: Database Schema
-- PostgreSQL 15+
-- NDC-first B2B Corporate Travel SaaS
-- =============================================================================
-- Conventions:
--   • All monetary values stored in integer cents (or smallest currency unit).
--   • Encrypted fields are BYTEA only; plaintext credentials never stored.
--   • audit_logs is append-only: app role has INSERT only, no UPDATE/DELETE.
--   • UUIDs via pgcrypto gen_random_uuid() — no sequential ID exposure.
--   • updated_at maintained automatically via set_updated_at() trigger.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EXTENSIONS
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- GIN trigram indexes for fuzzy name search

-- ---------------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------------

CREATE TYPE user_role AS ENUM (
    'SUPER_ADMIN',
    'ADMIN',
    'CONSULTANT',
    'SUB_AGENT'
);

CREATE TYPE user_status AS ENUM (
    'active',
    'inactive',
    'locked',
    'pending_verification'
);

CREATE TYPE ndc_auth_type AS ENUM (
    'API_KEY',    -- static key in header (X-Api-Key)
    'OAUTH2',     -- client_credentials grant
    'BASIC'       -- HTTP Basic with username:password
);

CREATE TYPE ndc_environment AS ENUM (
    'PRODUCTION',
    'SANDBOX',
    'TEST'
);

CREATE TYPE corporate_status AS ENUM (
    'active',
    'inactive',
    'suspended',
    'prospect'
);

CREATE TYPE service_fee_type AS ENUM (
    'FLAT',         -- fixed amount in cents per booking
    'PERCENTAGE'    -- basis points (e.g. 500 = 5.00 %)
);

-- ---------------------------------------------------------------------------
-- USERS
-- ---------------------------------------------------------------------------
-- Stores all platform users across all roles.
-- mfa_secret is a TOTP seed (NULL means MFA not yet enrolled).
-- failed_login_count + locked_until support brute-force lockout.
-- Soft-delete pattern: set status = 'inactive', never hard-delete.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(255)    NOT NULL,
    email               VARCHAR(255)    NOT NULL,
    password_hash       VARCHAR(255)    NOT NULL,   -- bcrypt, cost factor 12
    role                user_role       NOT NULL    DEFAULT 'CONSULTANT',
    status              user_status     NOT NULL    DEFAULT 'active',
    mfa_secret          VARCHAR(64),                -- encrypted TOTP seed; NULL = not enrolled
    last_login_at       TIMESTAMPTZ,
    failed_login_count  INT             NOT NULL    DEFAULT 0,
    locked_until        TIMESTAMPTZ,                -- NULL = not locked; future ts = lockout expiry
    created_by          UUID            REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ     NOT NULL    DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL    DEFAULT NOW(),

    CONSTRAINT users_email_unique   UNIQUE (email),
    CONSTRAINT users_email_format   CHECK  (email ~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$'),
    CONSTRAINT users_name_not_blank CHECK  (trim(name) <> '')
);

CREATE INDEX idx_users_email      ON users (email);
CREATE INDEX idx_users_role       ON users (role);
CREATE INDEX idx_users_status     ON users (status);
CREATE INDEX idx_users_created_by ON users (created_by);

-- ---------------------------------------------------------------------------
-- REFRESH TOKENS
-- ---------------------------------------------------------------------------
-- Server-side token store enables true logout and token rotation.
-- token_hash is SHA-256 hex of the raw token (raw token lives in httpOnly cookie only).
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(64)     NOT NULL,   -- SHA-256(raw_token) hex
    expires_at      TIMESTAMPTZ     NOT NULL,
    ip_address      INET,
    user_agent      TEXT,
    revoked         BOOLEAN         NOT NULL DEFAULT false,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT refresh_tokens_hash_unique UNIQUE (token_hash)
);

CREATE INDEX idx_rt_user_id    ON refresh_tokens (user_id);
CREATE INDEX idx_rt_token_hash ON refresh_tokens (token_hash);
CREATE INDEX idx_rt_expires_at ON refresh_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- AUDIT LOGS  (append-only — INSERT only for app role)
-- ---------------------------------------------------------------------------
-- payload_hash: SHA-256 hex of the sanitised (PII-stripped) request body.
-- resource_type / resource_id form a polymorphic reference (no FK by design).
-- result: 'success' | 'failure' | 'error'
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
    id              BIGSERIAL       PRIMARY KEY,
    user_id         UUID            REFERENCES users(id) ON DELETE SET NULL,
    action          VARCHAR(100)    NOT NULL,   -- e.g. 'USER_LOGIN', 'BOOKING_CREATE'
    resource_type   VARCHAR(100),               -- e.g. 'user', 'booking', 'corporate'
    resource_id     VARCHAR(255),               -- UUID or other PK of affected row
    ip_address      INET,
    user_agent      TEXT,
    payload_hash    VARCHAR(64),                -- SHA-256 hex of sanitised request body
    result          VARCHAR(20)     NOT NULL    CHECK (result IN ('success', 'failure', 'error')),
    created_at      TIMESTAMPTZ     NOT NULL    DEFAULT NOW()
);

-- Indexes support common audit queries: by user, by action, by resource, by time
CREATE INDEX idx_audit_user_id    ON audit_logs (user_id);
CREATE INDEX idx_audit_action     ON audit_logs (action);
CREATE INDEX idx_audit_resource   ON audit_logs (resource_type, resource_id);
CREATE INDEX idx_audit_created_at ON audit_logs (created_at DESC);
CREATE INDEX idx_audit_ip         ON audit_logs (ip_address);

-- Defense-in-depth: database-level rules prevent UPDATE/DELETE even by a
-- privileged session that bypasses GRANT restrictions.
CREATE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------------
-- NDC AIRLINE CONFIGS
-- ---------------------------------------------------------------------------
-- Each row represents one airline's NDC endpoint configuration for one
-- environment. Credentials are encrypted (AES-256-GCM) before INSERT.
-- The master encryption key lives in ENV only; credential_key references a
-- KMS key alias/ARN used to derive or wrap the encryption key — it is NOT
-- the key itself and is safe to store.
--
-- Encrypted field pairs:
--   api_key_enc     / iv_api_key       — static API key
--   api_secret_enc  / iv_api_secret    — API secret (API_KEY / BASIC auth)
--   access_token_enc/ iv_access_token  — OAuth2 bearer token cache
--
-- GET responses MUST NOT return any *_enc or iv_* columns.
-- ---------------------------------------------------------------------------
CREATE TABLE ndc_airline_configs (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    iata_code           CHAR(2)         NOT NULL,   -- IATA 2-letter airline designator
    airline_name        VARCHAR(255)    NOT NULL,
    ndc_version         VARCHAR(10)     NOT NULL    DEFAULT '21.3',
    endpoint_url        VARCHAR(2048)   NOT NULL,
    auth_type           ndc_auth_type   NOT NULL,
    environment         ndc_environment NOT NULL    DEFAULT 'SANDBOX',

    -- AES-256-GCM encrypted credential storage
    api_key_enc         BYTEA,          -- ciphertext of API key
    iv_api_key          BYTEA,          -- 12-byte random GCM IV for api_key
    api_secret_enc      BYTEA,          -- ciphertext of API secret
    iv_api_secret       BYTEA,          -- 12-byte random GCM IV for api_secret
    access_token_enc    BYTEA,          -- ciphertext of cached OAuth2 access token
    iv_access_token     BYTEA,          -- 12-byte random GCM IV for access_token
    token_expires_at    TIMESTAMPTZ,    -- when access_token_enc should be refreshed

    -- KMS key reference — alias or ARN, NOT the key material
    credential_key      VARCHAR(255),

    is_active           BOOLEAN         NOT NULL    DEFAULT true,
    last_ping_at        TIMESTAMPTZ,
    last_ping_ms        INT,            -- round-trip ms of last health check
    last_ping_ok        BOOLEAN,        -- true = ping returned valid NDC response

    created_by          UUID            NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ     NOT NULL    DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL    DEFAULT NOW(),

    -- One config per airline per environment (e.g. BA-PRODUCTION, BA-SANDBOX are distinct)
    CONSTRAINT ndc_iata_env_unique  UNIQUE (iata_code, environment),
    CONSTRAINT ndc_endpoint_https   CHECK  (endpoint_url ~* '^https://'),
    CONSTRAINT ndc_iata_uppercase   CHECK  (iata_code = upper(iata_code))
);

CREATE INDEX idx_ndc_iata_code ON ndc_airline_configs (iata_code);
CREATE INDEX idx_ndc_is_active ON ndc_airline_configs (is_active);
CREATE INDEX idx_ndc_env       ON ndc_airline_configs (environment);
CREATE INDEX idx_ndc_created_by ON ndc_airline_configs (created_by);

-- ---------------------------------------------------------------------------
-- CORPORATES
-- ---------------------------------------------------------------------------
-- Top-level client entity. address stored as JSONB for flexibility.
-- Monetary amounts (credit_limit, credit_used, service_fee_amount) in cents.
-- service_fee_amount is cents if FLAT, or basis-points if PERCENTAGE.
-- ---------------------------------------------------------------------------
CREATE TABLE corporates (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(255)    NOT NULL,
    tax_id              VARCHAR(50)     NOT NULL,   -- globally unique identifier
    sector              VARCHAR(100),
    employee_count      INT,
    contact_email       VARCHAR(255)    NOT NULL,
    contact_phone       VARCHAR(50),
    address             JSONB,          -- { "street": "", "city": "", "country": "", "zip": "" }
    coordinator_name    VARCHAR(255),
    contract_start      DATE,
    contract_end        DATE,
    service_fee_type    service_fee_type NOT NULL   DEFAULT 'FLAT',
    service_fee_amount  INT             NOT NULL    DEFAULT 0,
    credit_limit        INT             NOT NULL    DEFAULT 0,
    credit_used         INT             NOT NULL    DEFAULT 0,
    currency            CHAR(3)         NOT NULL    DEFAULT 'USD',
    payment_term_days   INT             NOT NULL    DEFAULT 30,
    status              corporate_status NOT NULL   DEFAULT 'active',
    notes               TEXT,
    created_by          UUID            NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ     NOT NULL    DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL    DEFAULT NOW(),

    CONSTRAINT corporates_tax_id_unique         UNIQUE  (tax_id),
    CONSTRAINT corporates_name_not_blank        CHECK   (trim(name) <> ''),
    CONSTRAINT corporates_credit_used_gte_zero  CHECK   (credit_used >= 0),
    CONSTRAINT corporates_credit_limit_gte_zero CHECK   (credit_limit >= 0),
    CONSTRAINT corporates_credit_available      CHECK   (credit_used <= credit_limit),
    CONSTRAINT corporates_service_fee_gte_zero  CHECK   (service_fee_amount >= 0),
    CONSTRAINT corporates_employee_count_pos    CHECK   (employee_count IS NULL OR employee_count > 0),
    CONSTRAINT corporates_payment_term_pos      CHECK   (payment_term_days > 0),
    CONSTRAINT corporates_contract_dates        CHECK   (
        contract_end IS NULL OR contract_start IS NULL OR contract_end > contract_start
    )
);

CREATE INDEX idx_corporates_status    ON corporates (status);
CREATE INDEX idx_corporates_tax_id    ON corporates (tax_id);
CREATE INDEX idx_corporates_created_by ON corporates (created_by);
-- Trigram index for fast partial-name search (e.g. /corporates?search=acme)
CREATE INDEX idx_corporates_name_trgm ON corporates USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- CORPORATE EMPLOYEES
-- ---------------------------------------------------------------------------
-- Travellers belonging to a corporate account.
-- passport_enc stores an AES-256-GCM encrypted JSON blob:
--   { number, nationality, dob, expiry, given_name, surname }
-- cabin_tier: preferred cabin stored as plain text; validated at app layer.
-- ---------------------------------------------------------------------------
CREATE TABLE corporate_employees (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    corporate_id    UUID            NOT NULL REFERENCES corporates(id) ON DELETE CASCADE,
    name            VARCHAR(255)    NOT NULL,
    title           VARCHAR(100),
    department      VARCHAR(100),
    email           VARCHAR(255)    NOT NULL,
    phone           VARCHAR(50),
    -- Passport PII — AES-256-GCM encrypted
    passport_enc    BYTEA,          -- ciphertext of passport JSON blob
    iv_passport     BYTEA,          -- 12-byte GCM IV
    cabin_tier      VARCHAR(20)     CHECK (cabin_tier IN ('economy', 'premium_economy', 'business', 'first')),
    status          VARCHAR(20)     NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'inactive', 'on_leave')),
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    -- Email must be unique within a corporate (same person at two corporates is OK)
    CONSTRAINT corp_employees_email_corp_unique UNIQUE (corporate_id, email),
    CONSTRAINT corp_employees_name_not_blank    CHECK  (trim(name) <> '')
);

CREATE INDEX idx_emp_corporate_id ON corporate_employees (corporate_id);
CREATE INDEX idx_emp_email        ON corporate_employees (email);
CREATE INDEX idx_emp_status       ON corporate_employees (status);
-- Trigram for search by traveller name within account
CREATE INDEX idx_emp_name_trgm    ON corporate_employees USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- CORPORATE TRAVEL POLICIES
-- ---------------------------------------------------------------------------
-- One policy record per corporate (UNIQUE constraint on corporate_id).
-- All fare caps stored in cents; NULL means no cap imposed.
-- approver_user_id: the platform user who must approve out-of-policy bookings.
-- effective_from / effective_to allow scheduling future policy changes.
-- ---------------------------------------------------------------------------
CREATE TABLE corporate_travel_policies (
    id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    corporate_id                UUID        NOT NULL REFERENCES corporates(id) ON DELETE CASCADE,

    -- Cabin class rules
    domestic_cabin              VARCHAR(20) NOT NULL DEFAULT 'economy'
                                            CHECK (domestic_cabin IN ('economy','premium_economy','business','first')),
    intl_short_cabin            VARCHAR(20) NOT NULL DEFAULT 'economy'
                                            CHECK (intl_short_cabin IN ('economy','premium_economy','business','first')),
    intl_long_cabin             VARCHAR(20) NOT NULL DEFAULT 'business'
                                            CHECK (intl_long_cabin IN ('economy','premium_economy','business','first')),
    long_haul_threshold_hours   INT         NOT NULL DEFAULT 4  CHECK (long_haul_threshold_hours > 0),

    -- Fare caps (cents); NULL = uncapped
    max_domestic_fare           INT         CHECK (max_domestic_fare IS NULL OR max_domestic_fare > 0),
    max_intl_fare               INT         CHECK (max_intl_fare IS NULL OR max_intl_fare > 0),
    max_hotel_per_night         INT         CHECK (max_hotel_per_night IS NULL OR max_hotel_per_night > 0),

    -- Advance booking requirement (days)
    min_advance_days            INT         NOT NULL DEFAULT 3 CHECK (min_advance_days >= 0),

    -- Refundability threshold (cents); NULL = refundability never required
    require_refundable_above    INT         CHECK (require_refundable_above IS NULL OR require_refundable_above > 0),

    -- Approval workflow threshold (cents); NULL = approval never required
    require_approval_above      INT         CHECK (require_approval_above IS NULL OR require_approval_above > 0),
    approver_user_id            UUID        REFERENCES users(id) ON DELETE SET NULL,

    effective_from              DATE        NOT NULL DEFAULT CURRENT_DATE,
    effective_to                DATE,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT policy_one_per_corporate UNIQUE (corporate_id),
    CONSTRAINT policy_dates_valid       CHECK  (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX idx_policy_corporate_id ON corporate_travel_policies (corporate_id);
CREATE INDEX idx_policy_approver     ON corporate_travel_policies (approver_user_id);

-- ---------------------------------------------------------------------------
-- BOOKINGS
-- ---------------------------------------------------------------------------
-- Core transactional table. One row = one booked flight segment (one-way or
-- one leg of a round trip). Multi-segment itineraries produce multiple rows
-- sharing the same PNR.
--
-- Monetary amounts in cents (base_fare + taxes + service_fee = total_amount
-- is enforced by CHECK constraint).
--
-- in_policy: set by checkPolicy() at search time; stored for reporting.
-- policy_override: consultant explicitly bypassed policy — requires reason.
-- ndc_order_id / ndc_offer_id: correlate back to the NDC provider session.
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    pnr                 VARCHAR(8)      NOT NULL,   -- Airline PNR / Record Locator
    corporate_id        UUID            NOT NULL REFERENCES corporates(id),
    employee_id         UUID            NOT NULL REFERENCES corporate_employees(id),
    consultant_id       UUID            NOT NULL REFERENCES users(id),
    airline_config_id   UUID            REFERENCES ndc_airline_configs(id) ON DELETE SET NULL,

    -- Route
    origin_iata         CHAR(3)         NOT NULL    CHECK (origin_iata = upper(origin_iata)),
    dest_iata           CHAR(3)         NOT NULL    CHECK (dest_iata = upper(dest_iata)),
    departure_at        TIMESTAMPTZ     NOT NULL,
    arrival_at          TIMESTAMPTZ     NOT NULL,

    -- Fare details
    cabin_class         VARCHAR(20)     NOT NULL
                                        CHECK (cabin_class IN ('economy','premium_economy','business','first')),
    fare_brand          VARCHAR(100),
    base_fare           INT             NOT NULL    CHECK (base_fare >= 0),
    taxes               INT             NOT NULL    DEFAULT 0 CHECK (taxes >= 0),
    service_fee         INT             NOT NULL    DEFAULT 0 CHECK (service_fee >= 0),
    total_amount        INT             NOT NULL    CHECK (total_amount >= 0),
    currency            CHAR(3)         NOT NULL    DEFAULT 'USD',

    -- Policy compliance
    in_policy           BOOLEAN         NOT NULL    DEFAULT true,
    policy_override     BOOLEAN         NOT NULL    DEFAULT false,
    override_reason     TEXT,

    -- Lifecycle
    status              VARCHAR(20)     NOT NULL    DEFAULT 'confirmed'
                                        CHECK (status IN ('pending','confirmed','ticketed','cancelled','refunded','void')),
    ndc_order_id        VARCHAR(255),
    ndc_offer_id        VARCHAR(255),
    booked_at           TIMESTAMPTZ     NOT NULL    DEFAULT NOW(),
    cancelled_at        TIMESTAMPTZ,

    CONSTRAINT bookings_pnr_unique              UNIQUE  (pnr),
    CONSTRAINT bookings_origin_dest_differ      CHECK   (origin_iata <> dest_iata),
    CONSTRAINT bookings_arrival_after_depart    CHECK   (arrival_at > departure_at),
    CONSTRAINT bookings_total_integrity         CHECK   (total_amount = base_fare + taxes + service_fee),
    CONSTRAINT bookings_override_needs_reason   CHECK   (
        policy_override = false OR (policy_override = true AND override_reason IS NOT NULL AND trim(override_reason) <> '')
    ),
    CONSTRAINT bookings_cancelled_when_status   CHECK   (
        cancelled_at IS NULL OR status IN ('cancelled', 'refunded', 'void')
    )
);

CREATE INDEX idx_bookings_pnr             ON bookings (pnr);
CREATE INDEX idx_bookings_corporate_id    ON bookings (corporate_id);
CREATE INDEX idx_bookings_employee_id     ON bookings (employee_id);
CREATE INDEX idx_bookings_consultant_id   ON bookings (consultant_id);
CREATE INDEX idx_bookings_status          ON bookings (status);
CREATE INDEX idx_bookings_departure_at    ON bookings (departure_at);
CREATE INDEX idx_bookings_booked_at       ON bookings (booked_at DESC);
-- Partial index: only index NDC order IDs that exist (saves space)
CREATE INDEX idx_bookings_ndc_order       ON bookings (ndc_order_id) WHERE ndc_order_id IS NOT NULL;

-- Composite: most common query pattern — all bookings for a corporate, newest first
CREATE INDEX idx_bookings_corp_booked     ON bookings (corporate_id, booked_at DESC);

-- ---------------------------------------------------------------------------
-- TRIGGERS — auto-maintain updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_ndc_updated_at
    BEFORE UPDATE ON ndc_airline_configs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_corporates_updated_at
    BEFORE UPDATE ON corporates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_policy_updated_at
    BEFORE UPDATE ON corporate_travel_policies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- DATABASE ROLES & GRANTS
-- ---------------------------------------------------------------------------
-- Run the following as a superuser during initial setup.
-- Replace <strong-password> with a generated secret (store in Vault / SSM).
--
-- Application role: minimum privilege, no SUPERUSER, no CREATEDB.
-- ---------------------------------------------------------------------------

-- CREATE ROLE agencyos_app LOGIN PASSWORD '<strong-password>' NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE agencyos TO agencyos_app;
GRANT USAGE   ON SCHEMA public     TO agencyos_app;

-- Full DML access on operational tables
GRANT SELECT, INSERT, UPDATE, DELETE ON
    users,
    refresh_tokens,
    ndc_airline_configs,
    corporates,
    corporate_employees,
    corporate_travel_policies,
    bookings
TO agencyos_app;

-- Sequence access for BIGSERIAL in audit_logs
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO agencyos_app;

-- audit_logs: INSERT ONLY — the DB rules above block UPDATE/DELETE at the
-- rule level; the GRANT restriction blocks at the privilege level (defence-in-depth).
GRANT INSERT ON audit_logs TO agencyos_app;
-- No SELECT granted intentionally; a separate read-only reporting role gets that.

-- Read-only reporting role (BI tooling, dashboards — no write access)
-- CREATE ROLE agencyos_readonly LOGIN PASSWORD '<readonly-password>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
-- GRANT CONNECT ON DATABASE agencyos TO agencyos_readonly;
-- GRANT USAGE ON SCHEMA public TO agencyos_readonly;
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO agencyos_readonly;
-- REVOKE SELECT ON ndc_airline_configs FROM agencyos_readonly;  -- never expose config to BI

-- ---------------------------------------------------------------------------
-- END OF SCHEMA
-- ---------------------------------------------------------------------------
