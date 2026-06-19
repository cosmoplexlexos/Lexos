import * as dotenv from 'dotenv';
// override: true — .env always wins over pre-existing shell env vars
dotenv.config({ override: true });

// ──────────────────────────────────────────────────────────
// Config — reads ALL values from environment variables.
// Never import a raw process.env value outside this file.
// ──────────────────────────────────────────────────────────

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `Copy .env.example to .env and fill in all values.`
    );
  }
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalFloat(name: string, fallback: number): number {
  const val = process.env[name];
  return val ? parseFloat(val) : fallback;
}

function optionalInt(name: string, fallback: number): number {
  const val = process.env[name];
  return val ? parseInt(val, 10) : fallback;
}

export const config = {
  supabase: {
    url:            required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },
  anthropic: {
    // Optional at server startup — only required when generation pipeline runs.
    apiKey: optional('ANTHROPIC_API_KEY', ''),
    model:  'claude-haiku-4-5-20251001',
  },
  cloudflare: {
    // Optional until Step 4 (semantic search). Validated lazily when first used.
    accountId:  optional('CLOUDFLARE_ACCOUNT_ID', ''),
    apiToken:   optional('CLOUDFLARE_API_TOKEN', ''),
    embedModel: '@cf/baai/bge-m3',            // switched from bge-base-en-v1.5 (768d) — see decisions.md
  },
  langsmith: {
    apiKey:   optional('LANGSMITH_API_KEY', ''),
    project:  optional('LANGSMITH_PROJECT', 'lexos'),
    endpoint: optional('LANGSMITH_ENDPOINT', 'https://api.smith.langchain.com'),
    enabled:  !!process.env['LANGSMITH_API_KEY'],
  },
  thresholds: {
    intentMatch:       optionalFloat('INTENT_MATCH_THRESHOLD', 0.75),
    phoneticAmbiguity: optionalFloat('PHONETIC_AMBIGUITY_THRESHOLD', 0.85),
  },
  classifier: {
    // Discriminative intent head (src/classifier/model.json). Decision rule for
    // the semantic stage: accept the classifier's intent only when its softmax
    // probability clears probThreshold AND the phrase is within oodSimFloor
    // cosine similarity of known vocabulary (out-of-domain rejection).
    // Lenient by design — a false miss on a real phrase is worse than a rare
    // off-domain pass. The action-cue gate (src/classifier/action-gate.ts) is
    // the real safety net for unrecognized actions, so the prob floor can stay
    // low to keep recall on borderline-but-valid phrases (correct in-domain
    // predictions run as low as ~0.17).
    probThreshold: optionalFloat('CLASSIFIER_PROB_THRESHOLD', 0.15),
    oodSimFloor:   optionalFloat('CLASSIFIER_OOD_SIM_FLOOR', 0.40),
    // Menu grounding: min cosine similarity for an utterance to count as
    // containing a tenant menu item. Validated separation — real items ~0.68+,
    // non-items / out-of-domain ~0.60-. Only used when the tenant has a menu.
    menuItemSimFloor: optionalFloat('MENU_ITEM_SIM_FLOOR', 0.62),
  },
  server: {
    port: optionalInt('PORT', 3000),
  },
  // Optional — when set, acts as a MASTER X-API-Key accepted on /enrich and
  // /retrieve in addition to per-tenant keys. Leave unset in local dev.
  apiKey: optional('LEXOS_API_KEY', ''),
  // Admin dashboard key — protects all /admin routes (X-Admin-Key header).
  adminKey: optional('LEXOS_ADMIN_KEY', ''),
  // Runtime vocabulary generation via the Anthropic API. OFF by default and per
  // project rule; the admin "Generate vocabulary" action is gated on this.
  generationEnabled: optional('GENERATION_ENABLED', 'false') === 'true',
} as const;

export type Config = typeof config;
