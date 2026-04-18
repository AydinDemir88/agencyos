-- =============================================================================
-- AgencyOS — Supabase-ready Schema (single script)
-- PostgreSQL 15+ / Supabase
--
-- HOW TO RUN:
--   1. Open Supabase Dashboard → SQL Editor → New query
--   2. Paste this entire file
--   3. Click Run
--
-- Notes:
--   • pgcrypto and pg_trgm are already enabled on Supabase — the CREATE
--     EXTENSION lines are included with IF NOT EXISTS so they are harmless.
--   • All ROLE / GRANT / REVOKE statements have been removed — Supabase
--     manages roles via its own auth layer. Connect your backend using the
--     service_role connection string from Project Settings → Database.
--   • audit_logs append-only enforcement uses CREATE RULE (not GRANTs) so
--     it works inside Supabase without superuser privileges.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EXTENSIONS
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ---------------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM (
    'SUPER_ADMIN', 'ADMIN', 'CONSULTANT', 'SUB_AGENT'
);

CREATE TYPE user_status AS ENUM (
    'active', 'inactive', 'locked', 'pending_verification'
);

CREATE TYPE ndc_auth_type AS ENUM (
    'API_KEY', 'OAUTH2', 'BASIC'
);

CREATE TYPE ndc_environment AS ENUM (
    'PRODUCTION', 'SANDBOX', 'TEST'
);

CREATE TYPE corporate_status AS ENUM (
    'active', 'inactive', 'suspended', 'prospect'
);

CREATE TYPE service_fee_type AS ENUM (
    'FLAT', 'PERCENTAGE'
);

-- ---------------------------------------------------------------------------
-- USERS
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(255)    NOT NULL,
    email               VARCHAR(255)    NOT NULL,
    password_hash       VARCHAR(255)    NOT NULL,
    role                user_role       NOT NULL DEFAULT 'CONSULTANT',
    status              user_status     NOT NULL DEFAULT 'active',
    mfa_secret          VARCHAR(64),
    last_login_at       TIMESTAMPTZ,
    failed_login_count  INT             NOT NULL DEFAULT 0,
    locked_until        TIMESTAMPTZ,
    created_by          UUID            REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

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
CREATE TABLE refresh_tokens (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(64) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    ip_address  INET,
    user_agent  TEXT,
    revoked     BOOLEAN     NOT NULL DEFAULT false,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT refresh_tokens_hash_unique UNIQUE (token_hash)
);

CREATE INDEX idx_rt_user_id    ON refresh_tokens (user_id);
CREATE INDEX idx_rt_token_hash ON refresh_tokens (token_hash);
CREATE INDEX idx_rt_expires_at ON refresh_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- AUDIT LOGS  (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
    id            BIGSERIAL    PRIMARY KEY,
    user_id       UUID         REFERENCES users(id) ON DELETE SET NULL,
    action        VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100),
    resource_id   VARCHAR(255),
    ip_address    INET,
    user_agent    TEXT,
    payload_hash  VARCHAR(64),
    result        VARCHAR(20)  NOT NULL CHECK (result IN ('success','failure','error')),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user_id    ON audit_logs (user_id);
CREATE INDEX idx_audit_action     ON audit_logs (action);
CREATE INDEX idx_audit_resource   ON audit_logs (resource_type, resource_id);
CREATE INDEX idx_audit_created_at ON audit_logs (created_at DESC);
CREATE INDEX idx_audit_ip         ON audit_logs (ip_address);

-- Append-only enforcement at the database rule level
CREATE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------------
-- NDC AIRLINE CONFIGS
-- ---------------------------------------------------------------------------
CREATE TABLE ndc_airline_configs (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    iata_code           CHAR(2)         NOT NULL,
    airline_name        VARCHAR(255)    NOT NULL,
    ndc_version         VARCHAR(10)     NOT NULL DEFAULT '21.3',
    endpoint_url        VARCHAR(2048)   NOT NULL,
    auth_type           ndc_auth_type   NOT NULL,
    environment         ndc_environment NOT NULL DEFAULT 'SANDBOX',
    api_key_enc         BYTEA,
    iv_api_key          BYTEA,
    api_secret_enc      BYTEA,
    iv_api_secret       BYTEA,
    access_token_enc    BYTEA,
    iv_access_token     BYTEA,
    token_expires_at    TIMESTAMPTZ,
    credential_key      VARCHAR(255),
    is_active           BOOLEAN         NOT NULL DEFAULT true,
    last_ping_at        TIMESTAMPTZ,
    last_ping_ms        INT,
    last_ping_ok        BOOLEAN,
    created_by          UUID            NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT ndc_iata_env_unique  UNIQUE (iata_code, environment),
    CONSTRAINT ndc_endpoint_https   CHECK  (endpoint_url ~* '^https://'),
    CONSTRAINT ndc_iata_uppercase   CHECK  (iata_code = upper(iata_code))
);

CREATE INDEX idx_ndc_iata_code   ON ndc_airline_configs (iata_code);
CREATE INDEX idx_ndc_is_active   ON ndc_airline_configs (is_active);
CREATE INDEX idx_ndc_env         ON ndc_airline_configs (environment);
CREATE INDEX idx_ndc_created_by  ON ndc_airline_configs (created_by);

-- ---------------------------------------------------------------------------
-- CORPORATES
-- ---------------------------------------------------------------------------
CREATE TABLE corporates (
    id                  UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(255)     NOT NULL,
    tax_id              VARCHAR(50)      NOT NULL,
    sector              VARCHAR(100),
    employee_count      INT,
    contact_email       VARCHAR(255)     NOT NULL,
    contact_phone       VARCHAR(50),
    address             JSONB,
    coordinator_name    VARCHAR(255),
    contract_start      DATE,
    contract_end        DATE,
    service_fee_type    service_fee_type NOT NULL DEFAULT 'FLAT',
    service_fee_amount  INT              NOT NULL DEFAULT 0,
    credit_limit        INT              NOT NULL DEFAULT 0,
    credit_used         INT              NOT NULL DEFAULT 0,
    currency            CHAR(3)          NOT NULL DEFAULT 'USD',
    payment_term_days   INT              NOT NULL DEFAULT 30,
    status              corporate_status NOT NULL DEFAULT 'active',
    notes               TEXT,
    created_by          UUID             NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

    CONSTRAINT corporates_tax_id_unique         UNIQUE (tax_id),
    CONSTRAINT corporates_name_not_blank        CHECK  (trim(name) <> ''),
    CONSTRAINT corporates_credit_used_gte_zero  CHECK  (credit_used >= 0),
    CONSTRAINT corporates_credit_limit_gte_zero CHECK  (credit_limit >= 0),
    CONSTRAINT corporates_credit_available      CHECK  (credit_used <= credit_limit),
    CONSTRAINT corporates_service_fee_gte_zero  CHECK  (service_fee_amount >= 0),
    CONSTRAINT corporates_payment_term_pos      CHECK  (payment_term_days > 0),
    CONSTRAINT corporates_contract_dates        CHECK  (
        contract_end IS NULL OR contract_start IS NULL OR contract_end > contract_start
    )
);

CREATE INDEX idx_corporates_status     ON corporates (status);
CREATE INDEX idx_corporates_tax_id     ON corporates (tax_id);
CREATE INDEX idx_corporates_created_by ON corporates (created_by);
CREATE INDEX idx_corporates_name_trgm  ON corporates USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- CORPORATE EMPLOYEES
-- ---------------------------------------------------------------------------
CREATE TABLE corporate_employees (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    corporate_id UUID        NOT NULL REFERENCES corporates(id) ON DELETE CASCADE,
    name         VARCHAR(255) NOT NULL,
    title        VARCHAR(100),
    department   VARCHAR(100),
    email        VARCHAR(255) NOT NULL,
    phone        VARCHAR(50),
    passport_enc BYTEA,
    iv_passport  BYTEA,
    cabin_tier   VARCHAR(20)  CHECK (cabin_tier IN ('economy','premium_economy','business','first')),
    status       VARCHAR(20)  NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','inactive','on_leave')),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT corp_employees_email_corp_unique UNIQUE (corporate_id, email),
    CONSTRAINT corp_employees_name_not_blank    CHECK  (trim(name) <> '')
);

CREATE INDEX idx_emp_corporate_id ON corporate_employees (corporate_id);
CREATE INDEX idx_emp_email        ON corporate_employees (email);
CREATE INDEX idx_emp_status       ON corporate_employees (status);
CREATE INDEX idx_emp_name_trgm    ON corporate_employees USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- CORPORATE TRAVEL POLICIES
-- ---------------------------------------------------------------------------
CREATE TABLE corporate_travel_policies (
    id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    corporate_id              UUID        NOT NULL REFERENCES corporates(id) ON DELETE CASCADE,
    domestic_cabin            VARCHAR(20) NOT NULL DEFAULT 'economy'
                                          CHECK (domestic_cabin IN ('economy','premium_economy','business','first')),
    intl_short_cabin          VARCHAR(20) NOT NULL DEFAULT 'economy'
                                          CHECK (intl_short_cabin IN ('economy','premium_economy','business','first')),
    intl_long_cabin           VARCHAR(20) NOT NULL DEFAULT 'business'
                                          CHECK (intl_long_cabin IN ('economy','premium_economy','business','first')),
    long_haul_threshold_hours INT         NOT NULL DEFAULT 4 CHECK (long_haul_threshold_hours > 0),
    max_domestic_fare         INT         CHECK (max_domestic_fare IS NULL OR max_domestic_fare > 0),
    max_intl_fare             INT         CHECK (max_intl_fare IS NULL OR max_intl_fare > 0),
    max_hotel_per_night       INT         CHECK (max_hotel_per_night IS NULL OR max_hotel_per_night > 0),
    min_advance_days          INT         NOT NULL DEFAULT 3 CHECK (min_advance_days >= 0),
    require_refundable_above  INT         CHECK (require_refundable_above IS NULL OR require_refundable_above > 0),
    require_approval_above    INT         CHECK (require_approval_above IS NULL OR require_approval_above > 0),
    approver_user_id          UUID        REFERENCES users(id) ON DELETE SET NULL,
    effective_from            DATE        NOT NULL DEFAULT CURRENT_DATE,
    effective_to              DATE,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT policy_one_per_corporate UNIQUE (corporate_id),
    CONSTRAINT policy_dates_valid       CHECK  (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX idx_policy_corporate_id ON corporate_travel_policies (corporate_id);
CREATE INDEX idx_policy_approver     ON corporate_travel_policies (approver_user_id);

-- ---------------------------------------------------------------------------
-- BOOKINGS
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pnr               VARCHAR(8)  NOT NULL,
    corporate_id      UUID        NOT NULL REFERENCES corporates(id),
    employee_id       UUID        NOT NULL REFERENCES corporate_employees(id),
    consultant_id     UUID        NOT NULL REFERENCES users(id),
    airline_config_id UUID        REFERENCES ndc_airline_configs(id) ON DELETE SET NULL,
    origin_iata       CHAR(3)     NOT NULL CHECK (origin_iata = upper(origin_iata)),
    dest_iata         CHAR(3)     NOT NULL CHECK (dest_iata = upper(dest_iata)),
    departure_at      TIMESTAMPTZ NOT NULL,
    arrival_at        TIMESTAMPTZ NOT NULL,
    cabin_class       VARCHAR(20) NOT NULL
                                  CHECK (cabin_class IN ('economy','premium_economy','business','first')),
    fare_brand        VARCHAR(100),
    base_fare         INT         NOT NULL CHECK (base_fare >= 0),
    taxes             INT         NOT NULL DEFAULT 0 CHECK (taxes >= 0),
    service_fee       INT         NOT NULL DEFAULT 0 CHECK (service_fee >= 0),
    total_amount      INT         NOT NULL CHECK (total_amount >= 0),
    currency          CHAR(3)     NOT NULL DEFAULT 'USD',
    in_policy         BOOLEAN     NOT NULL DEFAULT true,
    policy_override   BOOLEAN     NOT NULL DEFAULT false,
    override_reason   TEXT,
    status            VARCHAR(20) NOT NULL DEFAULT 'confirmed'
                                  CHECK (status IN ('pending','confirmed','ticketed','cancelled','refunded','void')),
    ndc_order_id      VARCHAR(255),
    ndc_offer_id      VARCHAR(255),
    booked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_at      TIMESTAMPTZ,

    CONSTRAINT bookings_pnr_unique            UNIQUE (pnr),
    CONSTRAINT bookings_origin_dest_differ    CHECK  (origin_iata <> dest_iata),
    CONSTRAINT bookings_arrival_after_depart  CHECK  (arrival_at > departure_at),
    CONSTRAINT bookings_total_integrity       CHECK  (total_amount = base_fare + taxes + service_fee),
    CONSTRAINT bookings_override_needs_reason CHECK  (
        policy_override = false
        OR (policy_override = true AND override_reason IS NOT NULL AND trim(override_reason) <> '')
    ),
    CONSTRAINT bookings_cancelled_status      CHECK  (
        cancelled_at IS NULL OR status IN ('cancelled','refunded','void')
    )
);

CREATE INDEX idx_bookings_pnr          ON bookings (pnr);
CREATE INDEX idx_bookings_corporate_id ON bookings (corporate_id);
CREATE INDEX idx_bookings_employee_id  ON bookings (employee_id);
CREATE INDEX idx_bookings_consultant_id ON bookings (consultant_id);
CREATE INDEX idx_bookings_status       ON bookings (status);
CREATE INDEX idx_bookings_departure_at ON bookings (departure_at);
CREATE INDEX idx_bookings_booked_at    ON bookings (booked_at DESC);
CREATE INDEX idx_bookings_ndc_order    ON bookings (ndc_order_id) WHERE ndc_order_id IS NOT NULL;
CREATE INDEX idx_bookings_corp_booked  ON bookings (corporate_id, booked_at DESC);

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

-- =============================================================================
-- END OF SCHEMA — paste into Supabase SQL Editor and click Run
-- =============================================================================
