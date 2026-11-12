-- SAKLAZ AI relay — şema v1
-- Relay İÇERİK saklamaz. Zarflardaki `ct`, uçtan uca şifreli veridir ve teslimden veya süre dolumundan sonra silinir.

CREATE TABLE IF NOT EXISTS accounts (
  id              uuid PRIMARY KEY,
  email           text NOT NULL,
  password_hash   text NOT NULL,                 -- Argon2id
  totp_secret_enc bytea NOT NULL,                -- AES-256-GCM; anahtar veritabanı dışında (gizli dosya)
  mfa_enabled     boolean NOT NULL DEFAULT false,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_lower ON accounts (lower(email));

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,              -- yalnızca özet saklanır
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz
);

CREATE TABLE IF NOT EXISTS devices (
  device_id    text PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('phone', 'computer')),
  sign_pub     text NOT NULL,                    -- yalnızca relay'e bağlanırken kimlik kanıtı için
  disabled     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS envelopes (
  id          uuid PRIMARY KEY,
  seq         bigserial UNIQUE,                  -- teslim sırası
  account_id  uuid NOT NULL,
  from_device text NOT NULL,
  to_device   text NOT NULL,
  kind        text NOT NULL,
  ct          text NOT NULL,                     -- uçtan uca şifreli; relay çözemez
  size        integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS envelopes_to ON envelopes (to_device, seq);
CREATE INDEX IF NOT EXISTS envelopes_exp ON envelopes (expires_at);

-- Meta veri denetim kaydı: yalnızca ekleme; hash zinciri uygulamada hesaplanır.
CREATE TABLE IF NOT EXISTS audit_meta (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  account_id  uuid,
  actor       text NOT NULL,
  action      text NOT NULL,
  details     jsonb NOT NULL,
  prev_hash   text NOT NULL,
  hash        text NOT NULL
);

-- Veritabanı rolünden bağımsız olarak denetim kaydının değiştirilmesini/silinmesini engeller.
CREATE OR REPLACE FUNCTION audit_meta_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_meta yalnızca ekleme kabul eder';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_meta_no_update ON audit_meta;
CREATE TRIGGER audit_meta_no_update BEFORE UPDATE OR DELETE ON audit_meta
  FOR EACH ROW EXECUTE FUNCTION audit_meta_append_only();
