-- ══════════════════════════════════════════════════════════
-- LEXOS — MIGRATION 008: Admin (tenants already exist) + API keys + menu
-- Run against the existing Supabase instance.
-- ══════════════════════════════════════════════════════════

-- ── api_keys ───────────────────────────────────────────────
-- Per-tenant API keys. The plaintext key is shown once at creation;
-- only its SHA-256 hash is stored. /enrich + /retrieve resolve the
-- calling tenant from the key.
CREATE TABLE IF NOT EXISTS api_keys (
  key_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    VARCHAR(50) NOT NULL,
  product_id   VARCHAR(50),
  key_hash     TEXT        NOT NULL,
  key_prefix   VARCHAR(20) NOT NULL,   -- shown in the dashboard for identification
  label        TEXT,
  active       BOOLEAN     DEFAULT true,
  created_at   TIMESTAMP   DEFAULT NOW(),
  last_used_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash   ON api_keys(key_hash) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);

-- ── menu_items ─────────────────────────────────────────────
-- A tenant's menu. Each item is embedded (bge-m3) so the enrich step
-- can ground utterances to real items by similarity ("filter kaapi"
-- → "Filter Coffee") and separate item actions from order actions.
CREATE TABLE IF NOT EXISTS menu_items (
  item_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   VARCHAR(50) NOT NULL,
  name        TEXT        NOT NULL,
  category    TEXT,
  price       NUMERIC(10,2),
  embedding   vector(1024),
  model_name  VARCHAR(128),
  created_at  TIMESTAMP   DEFAULT NOW()
);

-- CRITICAL: keep vectors inline (same rationale as vector_embeddings)
ALTER TABLE menu_items ALTER COLUMN embedding SET STORAGE PLAIN;
CREATE INDEX IF NOT EXISTS idx_menu_items_tenant ON menu_items(tenant_id);

-- Optional display name for tenants (admin dashboard). Safe if it already exists.
ALTER TABLE tenant_profiles ADD COLUMN IF NOT EXISTS display_name TEXT;

NOTIFY pgrst, 'reload schema';
