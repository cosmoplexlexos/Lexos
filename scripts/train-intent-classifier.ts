/**
 * train-intent-classifier.ts
 *
 * OFFLINE trainer for the intent classifier head (src/classifier/model.json).
 * Does NOT call any LLM — only the Cloudflare bge-m3 embedding endpoint.
 *
 * Pipeline:
 *   1. Pull every active term's COLLOQUIAL + CODE_MIXED variants, labelled
 *      with (language, intent_name).
 *   2. Embed all variant strings (batched bge-m3), L2-normalise.
 *   3. Train one multinomial logistic-regression model per language
 *      (softmax + L2 regularisation, full-batch gradient descent).
 *   4. Report train / held-out accuracy, write model.json.
 *
 * Usage: npx ts-node scripts/train-intent-classifier.ts
 */
import * as dotenv from 'dotenv'; dotenv.config({ override: true });
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { generateEmbeddingsBatch } from '../src/adapters/cloudflare-ai';
import { tokenize } from '../src/classifier/text-tokens';
import { normalizeRoman } from '../src/classifier/normalize';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const ACTIVE_LANGS = ['hi-IN', 'kn-IN', 'mr-IN', 'ta-IN', 'te-IN'];
const EPOCHS  = 600;
const LR      = 1.0;
const L2      = process.env.L2 ? parseFloat(process.env.L2) : 0.002;
const VAL_FRACTION = 0.15;
const EMB_CACHE = path.join(__dirname, 'data', '_emb_cache.json');

interface Example { text: string; lang: string; intent: string; }

function l2norm(v: number[]): number[] {
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
}

// Multinomial logistic regression, full-batch gradient descent.
function trainLR(X: number[][], y: number[], K: number, D: number) {
  const N = X.length;
  const W = Array.from({ length: K }, () => new Array<number>(D).fill(0));
  const b = new Array<number>(K).fill(0);

  // Class weights = inverse frequency, so a dominant class (e.g. CART_ADD_ITEM
  // with 4x the variants) can't drown out minority classes like REMOVE /
  // UPDATE_QUANTITY. Without this, a strong ADD token ("vada") pulls
  // "vada beda" / "vada kammi maadi" to ADD despite the action word.
  const counts = new Array<number>(K).fill(0);
  for (const yi of y) counts[yi]++;
  const classW = counts.map(c => (c > 0 ? N / (K * c) : 0));
  const wsum = y.reduce((s, yi) => s + classW[yi], 0);

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const gW = Array.from({ length: K }, () => new Array<number>(D).fill(0));
    const gb = new Array<number>(K).fill(0);

    for (let i = 0; i < N; i++) {
      const xi = X[i];
      const wi = classW[y[i]];
      // logits + softmax
      const logits = new Array<number>(K);
      let max = -Infinity;
      for (let k = 0; k < K; k++) {
        let dot = b[k]; const wk = W[k];
        for (let d = 0; d < D; d++) dot += wk[d] * xi[d];
        logits[k] = dot; if (dot > max) max = dot;
      }
      let sum = 0; const p = new Array<number>(K);
      for (let k = 0; k < K; k++) { const e = Math.exp(logits[k] - max); p[k] = e; sum += e; }
      for (let k = 0; k < K; k++) p[k] /= sum;
      // weighted grad of cross-entropy: w_i * (p - onehot)
      for (let k = 0; k < K; k++) {
        const err = wi * (p[k] - (y[i] === k ? 1 : 0));
        if (err !== 0) { const gk = gW[k]; for (let d = 0; d < D; d++) gk[d] += err * xi[d]; }
        gb[k] += err;
      }
    }
    // apply weighted-averaged grad + L2
    for (let k = 0; k < K; k++) {
      const wk = W[k], gk = gW[k];
      for (let d = 0; d < D; d++) wk[d] -= LR * (gk[d] / wsum + L2 * wk[d]);
      b[k] -= LR * (gb[k] / wsum);
    }
  }
  return { W, b };
}

function predict(W: number[][], b: number[], x: number[]): number {
  const K = W.length; let bestK = 0, best = -Infinity;
  for (let k = 0; k < K; k++) {
    let dot = b[k]; const wk = W[k];
    for (let d = 0; d < x.length; d++) dot += wk[d] * x[d];
    if (dot > best) { best = dot; bestK = k; }
  }
  return bestK;
}

async function main() {
  console.log('\nLexos — intent classifier training\n');

  // 1. Pull labelled variants
  const examples: Example[] = [];
  const { data: intents } = await supabase.from('lexos_intents').select('intent_id,intent_name');
  const intentById = new Map((intents ?? []).map((r: any) => [r.intent_id, r.intent_name]));

  const { data: terms } = await supabase
    .from('lexos_terms')
    .select('term_id,intent_id,language_code')
    .eq('active', true)
    .in('language_code', ACTIVE_LANGS);

  for (const t of terms ?? []) {
    const intentName = intentById.get((t as any).intent_id);
    if (!intentName) continue;
    const { data: vars } = await supabase
      .from('term_variants')
      .select('value,variant_type')
      .eq('term_id', (t as any).term_id)
      .in('variant_type', ['COLLOQUIAL', 'CODE_MIXED']);
    for (const v of vars ?? []) {
      const value = (v as any).value?.trim();
      // Normalize spelling so variants like "thegdhu"/"thegddhu" train as one.
      if (value) examples.push({ text: normalizeRoman(value), lang: (t as any).language_code, intent: intentName });
    }
  }
  console.log(`Collected ${examples.length} labelled variants across ${ACTIVE_LANGS.length} languages.`);

  // 2. Embed all (dedup identical strings; cache to disk for fast L2 sweeps)
  const uniqueTexts = Array.from(new Set(examples.map(e => e.text)));
  const cache: Record<string, number[]> = fs.existsSync(EMB_CACHE)
    ? JSON.parse(fs.readFileSync(EMB_CACHE, 'utf-8')) : {};
  const missing = uniqueTexts.filter(t => !cache[t]);
  console.log(`Embedding: ${uniqueTexts.length} unique, ${missing.length} new (rest cached)…`);
  if (missing.length) {
    const vecs = await generateEmbeddingsBatch(missing, 50);
    missing.forEach((t, i) => { cache[t] = vecs[i]; });
    fs.writeFileSync(EMB_CACHE, JSON.stringify(cache));
  }
  const embByText = new Map<string, number[]>();
  for (const t of uniqueTexts) embByText.set(t, l2norm(cache[t]));

  // 3. Train per language
  const D = embByText.get(uniqueTexts[0])!.length;
  console.log(`L2=${L2}, epochs=${EPOCHS}\n`);
  const model: any = { model_name: '@cf/baai/bge-m3', dim: D, trained_at: new Date().toISOString(), languages: {} };

  for (const lang of ACTIVE_LANGS) {
    const langEx = examples.filter(e => e.lang === lang);
    const intentNames = Array.from(new Set(langEx.map(e => e.intent))).sort();
    const idx = new Map(intentNames.map((n, i) => [n, i]));
    const K = intentNames.length;

    // random shuffle so the val split is representative (not alphabetical)
    const shuffled = [...langEx];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const valN = Math.floor(shuffled.length * VAL_FRACTION);
    const valSet = shuffled.slice(0, valN);
    const trainSet = shuffled.slice(valN);

    // Measure generalisation on a held-out split.
    const valModel = trainLR(trainSet.map(e => embByText.get(e.text)!), trainSet.map(e => idx.get(e.intent)!), K, D);
    const acc = (m: { W: number[][]; b: number[] }, set: Example[]) => {
      if (!set.length) return 1;
      let ok = 0;
      for (const e of set) if (predict(m.W, m.b, embByText.get(e.text)!) === idx.get(e.intent)) ok++;
      return ok / set.length;
    };
    console.log(`  ${lang}: ${langEx.length} ex, ${K} intents — train acc ${(acc(valModel, trainSet) * 100).toFixed(1)}%, val acc ${(acc(valModel, valSet) * 100).toFixed(1)}%`);

    // Final model: train on ALL examples for production.
    const full = trainLR(langEx.map(e => embByText.get(e.text)!), langEx.map(e => idx.get(e.intent)!), K, D);
    model.languages[lang] = { intents: intentNames, W: full.W, b: full.b };
  }

  // 4. Write model
  const outPath = path.join(process.cwd(), 'src', 'classifier', 'model.json');
  fs.writeFileSync(outPath, JSON.stringify(model));
  console.log(`\nWrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB).`);

  // 5. Write known-vocab token sets per language (for the action-cue gate)
  const vocab: Record<string, string[]> = {};
  for (const lang of ACTIVE_LANGS) {
    const toks = new Set<string>();
    for (const e of examples) if (e.lang === lang) for (const t of tokenize(e.text)) toks.add(t);
    vocab[lang] = Array.from(toks).sort();
  }
  const vocabPath = path.join(process.cwd(), 'src', 'classifier', 'vocab.json');
  fs.writeFileSync(vocabPath, JSON.stringify(vocab));
  console.log(`Wrote ${vocabPath} (${Object.entries(vocab).map(([l, v]) => `${l}:${v.length}`).join(', ')}).`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
