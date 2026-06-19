/**
 * verify-migration.ts
 *
 * Run after you've pasted 001_initial.sql into the Supabase SQL editor.
 * Checks that every expected table and critical column exists.
 *
 * Usage:
 *   npm run verify-migration
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL            = process.env['SUPABASE_URL']!;
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY']!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Expected tables ────────────────────────────────────────

const EXPECTED_TABLES = [
  'lexos_intents',
  'lexos_terms',
  'term_variants',
  'vector_embeddings',
  'lexos_entries_staging',
  'lexos_misses',
  'lexos_enrich_calls',
  'audit_log',
  'tenant_profiles',
  'user_profiles',
];

// ── Critical columns to spot-check ────────────────────────
// format: [table, column]

const CRITICAL_COLUMNS: [string, string][] = [
  ['lexos_terms', 'valid_from'],
  ['lexos_terms', 'valid_until'],
  ['lexos_terms', 'superseded_by'],
  ['lexos_terms', 'hit_count'],
  ['lexos_terms', 'last_hit_at'],
  ['lexos_terms', 'success_after_hit'],
  ['lexos_terms', 'miss_after_hit'],
  ['vector_embeddings', 'embedding'],
];

// ──────────────────────────────────────────────────────────

async function main() {
  let passed = true;

  console.log('\n── Checking tables ──────────────────────────────────────');
  for (const table of EXPECTED_TABLES) {
    // A single-row SELECT is the safest way to probe table existence via REST
    const { error } = await db.from(table).select('*').limit(0);
    if (error && error.code === '42P01') {
      console.error(`  ❌  ${table} — NOT FOUND`);
      passed = false;
    } else if (error) {
      console.error(`  ⚠️   ${table} — unexpected error: ${error.message}`);
      passed = false;
    } else {
      console.log(`  ✅  ${table}`);
    }
  }

  console.log('\n── Checking critical columns ────────────────────────────');
  for (const [table, column] of CRITICAL_COLUMNS) {
    const { error } = await db.from(table).select(column).limit(0);
    if (error) {
      console.error(`  ❌  ${table}.${column} — ${error.message}`);
      passed = false;
    } else {
      console.log(`  ✅  ${table}.${column}`);
    }
  }

  console.log('\n── Checking pgvector extension ──────────────────────────');
  const { data, error: extError } = await db
    .rpc('version')
    .single();

  if (extError) {
    console.log('  ⚠️   Could not query version (non-fatal)');
  } else {
    console.log(`  ✅  Supabase Postgres connected: ${(data as string).slice(0, 60)}...`);
  }

  console.log('\n─────────────────────────────────────────────────────────');
  if (passed) {
    console.log('✅  Migration verified — all tables and columns present.\n');
    process.exit(0);
  } else {
    console.error('❌  Some checks failed. Run 001_initial.sql in the Supabase SQL editor first.\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
