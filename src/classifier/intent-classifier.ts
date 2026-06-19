import * as fs from 'fs';
import * as path from 'path';

// ──────────────────────────────────────────────────────────
// Intent classifier — discriminative head over bge-m3 embeddings.
//
// Replaces nearest-neighbour-to-centroid as the decision rule for the
// semantic stage. A small multinomial logistic-regression model (one per
// language) is trained OFFLINE by scripts/train-intent-classifier.ts on the
// labelled variant corpus, and serialised to model.json.
//
// Why this exists: cosine-NN over sentence embeddings cannot learn that a
// shared function word ("kodi" = give) is non-discriminative. A trained linear
// head down-weights tokens that appear across many intents and up-weights the
// ones that actually separate them ("bill" vs a menu item). Inference is a
// single matrix-multiply (sub-millisecond), runs offline-trained weights, and
// stays multilingual via the frozen bge-m3 features.
//
// Returns null when no model is available, so the SDK can fall back to NN.
// ──────────────────────────────────────────────────────────

interface LangModel {
  intents: string[];   // K intent names, index = class id
  W:       number[][]; // K × D weight matrix
  b:       number[];   // K bias
}

interface IntentModel {
  model_name: string;
  dim:        number;
  trained_at: string;
  languages:  Record<string, LangModel>;
}

export interface ClassifierResult {
  intent: string;
  prob:   number;   // softmax probability of the winning class
}

// Stable in both ts-node (src/classifier) and compiled prod (dist/classifier)
// because the JSON files live under src/classifier/ throughout.
const MODEL_PATH = path.join(process.cwd(), 'src', 'classifier', 'model.json');

let _model: IntentModel | null | undefined; // undefined = not loaded yet, null = unavailable

function loadModel(): IntentModel | null {
  if (_model !== undefined) return _model;
  try {
    const raw = fs.readFileSync(MODEL_PATH, 'utf-8');
    _model = JSON.parse(raw) as IntentModel;
  } catch {
    _model = null; // no model trained yet → caller falls back to NN
  }
  return _model;
}

/** For tests / retrain hot-reload. */
export function resetModelCache(): void { _model = undefined; }

export function classifierAvailable(): boolean { return loadModel() !== null; }

function l2normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map(x => x / norm);
}

/** Full softmax probability per intent for one language model. */
function softmaxProbs(lm: LangModel, x: number[]): Array<{ intent: string; prob: number }> {
  const K = lm.intents.length;
  const logits = new Array<number>(K);
  for (let k = 0; k < K; k++) {
    let dot = lm.b[k];
    const wk = lm.W[k];
    for (let d = 0; d < x.length; d++) dot += wk[d] * x[d];
    logits[k] = dot;
  }
  let max = -Infinity;
  for (const l of logits) if (l > max) max = l;
  let sum = 0;
  const exps = logits.map(l => { const e = Math.exp(l - max); sum += e; return e; });
  return lm.intents.map((intent, k) => ({ intent, prob: exps[k] / sum }));
}

function predictWithLangModel(lm: LangModel, x: number[]): ClassifierResult {
  let best: ClassifierResult = { intent: lm.intents[0], prob: -1 };
  for (const p of softmaxProbs(lm, x)) if (p.prob > best.prob) best = p;
  return best;
}

/**
 * Argmax restricted to an allowed set of intents — used by the menu
 * composition step to re-pick the best ORDER-level intent when an item-action
 * was vetoed for having no menu item present.
 */
export function classifyRestricted(
  embedding: number[],
  lang: string | null,
  allowed: Set<string>,
): ClassifierResult | null {
  const model = loadModel();
  if (!model || !lang) return null;
  const lm = model.languages[lang];
  if (!lm) return null;
  const x = l2normalize(embedding);
  let best: ClassifierResult | null = null;
  for (const p of softmaxProbs(lm, x)) {
    if (!allowed.has(p.intent)) continue;
    if (!best || p.prob > best.prob) best = p;
  }
  return best;
}

/**
 * Classify a phrase embedding into an intent.
 *
 * @param embedding raw bge-m3 vector (will be L2-normalised here)
 * @param lang      BCP-47 code; when null, every language model is run and the
 *                  globally most-confident prediction is returned.
 * @returns { intent, prob } or null if no model / no model for that language.
 */
export function classifyIntent(embedding: number[], lang: string | null): ClassifierResult | null {
  const model = loadModel();
  if (!model) return null;
  const x = l2normalize(embedding);

  if (lang) {
    const lm = model.languages[lang];
    if (!lm) return null;
    return predictWithLangModel(lm, x);
  }

  // Unknown language → run all, take the most confident.
  let best: ClassifierResult | null = null;
  for (const lm of Object.values(model.languages)) {
    const r = predictWithLangModel(lm, x);
    if (!best || r.prob > best.prob) best = r;
  }
  return best;
}
