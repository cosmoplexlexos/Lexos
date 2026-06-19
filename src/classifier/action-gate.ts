import * as fs from 'fs';
import * as path from 'path';
import { tokenize } from './text-tokens';
import { normalizeRoman } from './normalize';

// ──────────────────────────────────────────────────────────
// Action-cue safety gate.
//
// A single embedding classifier always produces a best guess. When the action
// verb is unknown ("ondu vada <unknown>"), the familiar item noun ("vada")
// drags the guess to CART_ADD_ITEM — a confident-but-wrong result, worse than a
// miss. This gate refuses to trust a classifier result unless the phrase shows
// it was actually understood:
//
//   accept if  (a) it contains a recognized ACTION cue (verb/marker), OR
//              (b) every token is already known vocabulary (covers bare-item
//                  ADD like "ondu vada", and any fully-seen phrase).
//
// A known item + an unrecognized salient word + no action cue → NOT accepted
// → the SDK returns a miss. A NOVEL dish with a KNOWN verb ("khara bath kodi")
// still passes, because "kodi" is a recognized cue.
//
// Cues are curated (action-cues.json); vocab is derived from the corpus by the
// trainer (vocab.json) and grows automatically with the vocabulary.
// ──────────────────────────────────────────────────────────

interface ActionGroups { remove: Set<string>; qty: Set<string>; price: Set<string>; }
let _cues: Record<string, Set<string>> | undefined;
let _vocab: Record<string, Set<string>> | undefined;
let _filler: Set<string> = new Set();
let _itemActions: Record<string, ActionGroups> = {};

function load(): void {
  if (_cues !== undefined) return;
  _cues = {};
  _vocab = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src', 'classifier', 'action-cues.json'), 'utf-8'));
    // Normalize cues/filler so they match the normalized query tokens.
    _filler = new Set((raw._filler ?? []).map((t: string) => normalizeRoman(t)) as string[]);
    const norm = (a: string[]) => new Set((a ?? []).map(normalizeRoman));
    for (const [lang, g] of Object.entries(raw._item_actions ?? {})) {
      const gg = g as any;
      _itemActions[lang] = { remove: norm(gg.remove), qty: norm(gg.qty), price: norm(gg.price) };
    }
    for (const [lang, toks] of Object.entries(raw)) {
      if (lang.startsWith('_')) continue;
      _cues[lang] = new Set((toks as string[]).map(t => normalizeRoman(t)));
    }
  } catch { /* no cues file → gate stays permissive */ }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src', 'classifier', 'vocab.json'), 'utf-8'));
    for (const [lang, toks] of Object.entries(raw)) _vocab![lang] = new Set(toks as string[]);
  } catch { /* no vocab file → gate stays permissive */ }
}

export function resetActionGateCache(): void { _cues = undefined; _vocab = undefined; _filler = new Set(); _itemActions = {}; }

/**
 * True if the phrase contains a salient token that is neither filler, nor a
 * known action cue, nor a known menu token. Used to fail SAFE even when a menu
 * item matched: "ondu vada eseyiri" ("eseyiri" unknown) → unknown content →
 * the caller returns a miss instead of guessing ADD. A confident wrong intent
 * is worse than a miss.
 */
export function hasUnknownContent(phrase: string, lang: string | null, menuTokens: Set<string>): boolean {
  load();
  const cues = lang ? _cues![lang] : undefined;
  for (const t of tokenize(normalizeRoman(phrase))) {
    if (_filler.has(t)) continue;
    if (menuTokens.has(t)) continue;
    if (cues && cues.has(t)) continue;
    return true;
  }
  return false;
}

/**
 * Given a menu item is present, pick the item-scoped intent from action cues:
 * remove > quantity > price > add (default). Deterministic — the item is
 * grounded by the menu, so the action comes from explicit cues, not the
 * whole-phrase classifier (which conflates "kodi"=add vs "beda"=remove).
 */
export function pickItemAction(phrase: string, lang: string | null): string {
  load();
  const g = lang ? _itemActions[lang] : undefined;
  if (!g) return 'LEXOS_CART_ADD_ITEM';
  const toks = tokenize(normalizeRoman(phrase));
  const has = (s: Set<string>) => toks.some(t => s.has(t));
  if (has(g.remove)) return 'LEXOS_CART_REMOVE_ITEM';
  if (has(g.qty))    return 'LEXOS_CART_UPDATE_QUANTITY';
  if (has(g.price))  return 'LEXOS_PRICE_INQUIRY_ITEM';
  return 'LEXOS_CART_ADD_ITEM';
}

/**
 * Returns true if the classifier's intent for this phrase should be trusted.
 * Permissive (returns true) when we have no cues/vocab for the language, so the
 * gate never blocks a language it can't evaluate — the prob/OOD gates still apply.
 */
export function actionRecognized(phrase: string, lang: string | null): boolean {
  load();
  if (!lang) return true;
  const cues = _cues![lang];
  const vocab = _vocab![lang];
  if (!cues && !vocab) return true;

  const toks = tokenize(normalizeRoman(phrase));
  if (toks.length === 0) return true;
  if (cues && toks.some(t => cues.has(t))) return true;        // recognized action
  // Ignore filler (numbers, address/dative particles) so a rare one can't trip
  // the gate; an unknown VERB is never filler, so it still triggers a miss.
  const salient = toks.filter(t => !_filler.has(t));
  if (salient.length === 0) return true;                       // only item + filler
  if (vocab && salient.every(t => vocab.has(t))) return true;  // every salient token known
  return false;                                                // unknown salient content
}
