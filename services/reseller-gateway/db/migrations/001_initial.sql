BEGIN;

CREATE TABLE app_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_users_email_normalized CHECK (email = lower(email))
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX tenant_memberships_user_idx ON tenant_memberships(user_id);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE voipms_reseller_clients (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  reseller_client_id text UNIQUE,
  provisioning_status text NOT NULL DEFAULT 'pending'
    CHECK (provisioning_status IN ('pending', 'active', 'suspended', 'failed', 'closed')),
  package_id text,
  portal_email text,
  provisioned_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voipms_dids (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  did text NOT NULL,
  label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'released')),
  upstream_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, did),
  UNIQUE (did)
);

CREATE TABLE voipms_subaccounts (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subaccount text NOT NULL,
  label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'closed')),
  upstream_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subaccount),
  UNIQUE (subaccount)
);

CREATE TABLE entitlements (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entitlement_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'grace', 'expired', 'revoked')),
  source text NOT NULL CHECK (source IN ('manual', 'revenuecat', 'woocommerce', 'voipms')),
  external_reference text,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entitlement_key)
);

CREATE TABLE billing_identities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('revenuecat', 'woocommerce')),
  external_customer_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_customer_id),
  UNIQUE (tenant_id, provider)
);

CREATE TABLE commerce_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('revenuecat', 'woocommerce')),
  external_event_id text NOT NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  processing_status text NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received', 'applied', 'ignored', 'failed')),
  error_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, external_event_id)
);

CREATE TABLE credit_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('credit', 'debit', 'reversal')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  source text NOT NULL CHECK (source IN ('revenuecat', 'woocommerce', 'manual', 'voipms')),
  external_reference text,
  upstream_reference text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'failed', 'reversed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  UNIQUE (source, external_reference)
);
CREATE INDEX credit_ledger_tenant_created_idx ON credit_ledger(tenant_id, created_at DESC);

CREATE TABLE provisioning_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_payload jsonb,
  error_message text,
  run_after timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provisioning_jobs_ready_idx ON provisioning_jobs(status, run_after);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  target_type text,
  target_id text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_created_idx ON audit_events(tenant_id, created_at DESC);

COMMIT;
