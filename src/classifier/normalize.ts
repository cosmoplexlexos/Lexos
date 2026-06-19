// ──────────────────────────────────────────────────────────
// Romanized-Indic spelling normalizer.
//
// Romanized Hindi/Kannada/Tamil/Telugu/Marathi has no canonical spelling:
// "ondu" / "ondhu", "thegdhu" / "thegddhu" / "tegidu", "bisaaku" / "bisaku".
// Short phrases on a thin-signal intent sit near the classifier's decision
// boundary, so one extra letter can flip the prediction. Collapsing the common
// spelling variations to a canonical form — applied to BOTH the training text
// and the query — makes those variants embed identically and resolve the same.
//
// Latin only. Native-script characters fall outside the ASCII classes below and
// pass through unchanged, so Devanagari/Kannada/Tamil/Telugu text is untouched.
// ──────────────────────────────────────────────────────────
export function normalizeRoman(s: string): string {
  return s
    .toLowerCase()
    .replace(/([bdgjkpt])h/g, '$1')                   // drop aspiration: dh→d, th→t, bh→b… (keep ch, sh)
    .replace(/([bcdfghjklmnpqrstvwxyz])\1+/g, '$1')   // collapse doubled consonants: dd→d, tt→t…
    .replace(/([aeiou])\1+/g, '$1')                   // collapse doubled vowels: aa→a, oo→o…
    .replace(/\s+/g, ' ')
    .trim();
}
