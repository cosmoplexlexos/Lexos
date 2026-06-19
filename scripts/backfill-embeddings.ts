/**
 * Backfill embeddings — generates Cloudflare AI embeddings for all
 * active terms that don't yet have a row in vector_embeddings.
 *
 * Uses the COLLOQUIAL variant as the embedding source (most speech-like).
 * Falls back to FORMAL if no COLLOQUIAL variant exists.
 *
 * Run after:
 *   1. npm run load-seeds  (terms must be in DB)
 *   2. migration 002_vector_search_fn.sql (run in Supabase)
 *
 * Usage:
 *   npm run backfill-embeddings            # all terms
 *   npm run backfill-embeddings -- --lang hi-IN  # specific language
 *   npm run backfill-embeddings -- --dry-run     # no DB writes
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { getDb } from '../src/db/client';
import { generateEmbeddingsBatch, EMBED_MODEL_NAME, EMBED_MODEL_VERSION } from '../src/adapters/cloudflare-ai';

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

interface TermRow {
  term_id:       string;
  language_code: string;
  domain:        string;
}

interface VariantRow {
  term_id:      string;
  variant_type: string;
  value:        string;
}

// ──────────────────────────────────────────────────────────
// Args
// ──────────────────────────────────────────────────────────

function parseArgs(): { langFilter: string | null; dryRun: boolean } {
  const args = process.argv.slice(2);
  const langIdx = args.indexOf('--lang');
  const langFilter = langIdx !== -1 && args[langIdx + 1] ? args[langIdx + 1]! : null;
  const dryRun = args.includes('--dry-run');
  return { langFilter, dryRun };
}

// ──────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────

async function main() {
  const { langFilter, dryRun } = parseArgs();
  const db = getDb();
  const BATCH_SIZE = 10;

  console.log('\n═══════════════════════════════════════════════');
  console.log(' Lexos — Backfill Embeddings');
  console.log(`  Mode:  ${dryRun ? 'DRY RUN (no DB writes)' : 'LIVE'}`);
  console.log(`  Model: ${EMBED_MODEL_NAME}`);
  if (langFilter) console.log(`  Lang:  ${langFilter}`);
  console.log('═══════════════════════════════════════════════\n');

  // 1. Find all active terms without an embedding
  let termsQuery = db
    .from('lexos_terms')
    .select('term_id, language_code, domain')
    .eq('active', true)
    .is('superseded_by', null);

  if (langFilter) {
    termsQuery = termsQuery.eq('language_code', langFilter);
  }

  const { data: allTerms, error: termsErr } = await termsQuery;
  if (termsErr) throw new Error(`Failed to fetch terms: ${termsErr.message}`);

  // 2. Get term_ids that already have embeddings
  const { data: existingEmbs, error: embsErr } = await db
    .from('vector_embeddings')
    .select('term_id');
  if (embsErr) throw new Error(`Failed to fetch existing embeddings: ${embsErr.message}`);

  const alreadyEmbedded = new Set((existingEmbs ?? []).map((r: { term_id: string }) => r.term_id));

  const terms = (allTerms ?? [] as TermRow[]).filter(
    (t: TermRow) => !alreadyEmbedded.has(t.term_id),
  ) as TermRow[];

  console.log(`Terms without embeddings: ${terms.length}`);
  if (terms.length === 0) {
    console.log('Nothing to backfill — all terms already have embeddings.');
    return;
  }

  // 3. Fetch variant values in chunks to avoid URL length limits
  const termIds = terms.map(t => t.term_id);
  const CHUNK = 100;
  const allVariants: VariantRow[] = [];
  for (let i = 0; i < termIds.length; i += CHUNK) {
    const chunk = termIds.slice(i, i + CHUNK);
    const { data, error: varErr } = await db
      .from('term_variants')
      .select('term_id, variant_type, value')
      .in('term_id', chunk)
      .in('variant_type', ['COLLOQUIAL', 'FORMAL']);
    if (varErr) throw new Error(`Failed to fetch variants: ${varErr.message}`);
    allVariants.push(...((data ?? []) as VariantRow[]));
  }
  const variants = allVariants;

  // Map term_id → best variant text
  const varMap = new Map<string, string>();
  for (const v of (variants ?? []) as VariantRow[]) {
    const existing = varMap.get(v.term_id);
    // Prefer COLLOQUIAL over FORMAL
    if (!existing || v.variant_type === 'COLLOQUIAL') {
      varMap.set(v.term_id, v.value);
    }
  }

  // Build ordered list of (termId, text) pairs
  const todo = terms
    .map(t => ({ term_id: t.term_id, text: varMap.get(t.term_id) ?? '' }))
    .filter(t => t.text !== '');

  const skippedNoVariant = terms.length - todo.length;
  if (skippedNoVariant > 0) {
    console.warn(`  ⚠  ${skippedNoVariant} terms skipped — no COLLOQUIAL or FORMAL variant found\n`);
  }

  console.log(`Processing ${todo.length} terms in batches of ${BATCH_SIZE}...\n`);

  let inserted = 0;
  let failed   = 0;

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(todo.length / BATCH_SIZE);

    process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} terms)... `);

    try {
      if (dryRun) {
        console.log('DRY RUN — skipped');
        inserted += batch.length;
        continue;
      }

      // Generate embeddings for the batch
      const texts      = batch.map(b => b.text);
      const embeddings = await generateEmbeddingsBatch(texts, BATCH_SIZE);

      // Insert into vector_embeddings
      // Serialize embedding as string — Supabase JS sends number[] as JSON array
      // which pgvector can't cast reliably. String form '[v1,v2,...]' works.
      const rows = batch.map((b, idx) => ({
        term_id:       b.term_id,
        embedding:     `[${embeddings[idx]!.join(',')}]`,
        model_version: EMBED_MODEL_VERSION,
        model_name:    EMBED_MODEL_NAME,
      }));

      const { error: insErr } = await db.from('vector_embeddings').insert(rows);
      if (insErr) throw new Error(insErr.message);

      inserted += batch.length;
      console.log(`✅ +${batch.length}`);
    } catch (err) {
      failed += batch.length;
      console.log(`❌ failed: ${(err as Error).message}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log(' Summary');
  console.log('═══════════════════════════════════════════════');
  console.log(` Embedded:      ${inserted}`);
  console.log(` Failed:        ${failed}`);
  console.log(` Already had:   ${alreadyEmbedded.size}`);
  console.log(` No variant:    ${skippedNoVariant}`);
  console.log('');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
