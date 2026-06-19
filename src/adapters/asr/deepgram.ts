import { PhoneticVariant } from '../../db/queries/retrieve';

// ──────────────────────────────────────────────────────────
// Deepgram Nova-3 adapter — keywords string[]
//
// Deepgram accepts up to 100 keyword strings for boosting.
// Before building the payload, PHONETIC_AMBIGUITY_THRESHOLD
// is applied: variants with confidence below the threshold are
// excluded (they're too phonetically ambiguous to boost safely).
// ──────────────────────────────────────────────────────────

export interface DeepgramPayload {
  keywords: string[];
}

const MAX_KEYWORDS = 100;

/**
 * Formats PHONETIC variants into a Deepgram Nova-3 keywords array.
 *
 * Filtering:
 *   1. Exclude variants with confidence < phoneticAmbiguityThreshold
 *      (low-confidence variants are phonetically ambiguous — boosting them
 *      risks mis-transcribing similar-sounding but unrelated words)
 *   2. Sort by confidence descending (highest quality first)
 *   3. Limit to MAX_KEYWORDS (Deepgram hard cap)
 */
export function formatDeepgramPayload(
  variants:                   PhoneticVariant[],
  phoneticAmbiguityThreshold: number,
): DeepgramPayload {
  const keywords = variants
    .filter(v => v.confidence >= phoneticAmbiguityThreshold)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_KEYWORDS)
    .map(v => v.value);

  return { keywords };
}
