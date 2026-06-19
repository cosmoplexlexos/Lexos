import { PhoneticVariant } from '../../db/queries/retrieve';

// ──────────────────────────────────────────────────────────
// Sarvam Saarika V3 adapter — vocabulary hints
//
// Saarika V3 accepts a vocabulary hints array where each entry
// carries the display word and optional phonetic spellings.
// Per Saarika V3 spec:
//   { word: string, sounds_like?: string[] }
// ──────────────────────────────────────────────────────────

export interface SarvamHint {
  word:         string;
  sounds_like?: string[];
}

export interface SarvamPayload {
  vocabulary_hints: SarvamHint[];
}

/**
 * Formats PHONETIC variants into Sarvam Saarika V3 vocabulary_hints.
 *
 * Each PHONETIC variant becomes a hint entry. Where the romanised
 * value contains multiple space-separated words, the whole phrase
 * is treated as a compound keyword (Saarika supports multi-word hints).
 */
export function formatSarvamPayload(variants: PhoneticVariant[]): SarvamPayload {
  const vocabulary_hints: SarvamHint[] = variants.map(v => ({
    word: v.value,
  }));

  return { vocabulary_hints };
}
