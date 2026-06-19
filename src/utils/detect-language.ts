// ──────────────────────────────────────────────────────────
// Language detection from raw phrase text.
//
// ACTIVE languages: hi-IN, kn-IN, mr-IN, ta-IN, te-IN.
// DISABLED (active=false in DB): bn-IN, gu-IN, es-ES, ar-AE.
//   See scripts/toggle-languages.ts to re-enable.
//
// Strategy:
//   1. Non-Latin script → unique Unicode ranges → high-confidence detection
//   2. Devanagari → hi-IN (covers mr-IN too — bge-m3 handles the overlap)
//   3. Latin + romanized Dravidian markers → kn-IN / ta-IN / te-IN
//   4. Latin ambiguous (romanized Hinglish, English) → null → global search
//
// Returns a BCP-47 code matching our supported set, or null when uncertain.
// Null tells the enrich SDK to search across all languages (no lang filter).
// ──────────────────────────────────────────────────────────

// The bn/gu/ar script ranges are kept on purpose even though those languages
// are disabled: a phrase in one of those scripts is routed to its own (now
// empty, active=false) set and returns a clean miss, rather than falling
// through to a global search where multilingual embeddings could spuriously
// cross-match an active Indian-language term. Their scripts don't overlap the
// 5 active languages, so they can never steal an Indian-language phrase.
const SCRIPT_RANGES: Array<{ pattern: RegExp; lang: string }> = [
  { pattern: /[஀-௿]/, lang: 'ta-IN' },  // Tamil
  { pattern: /[ఀ-౿]/, lang: 'te-IN' },  // Telugu
  { pattern: /[ಀ-೿]/, lang: 'kn-IN' },  // Kannada
  { pattern: /[ঀ-৿]/, lang: 'bn-IN' },  // Bengali (disabled — routes to clean miss)
  { pattern: /[઀-૿]/, lang: 'gu-IN' },  // Gujarati (disabled — routes to clean miss)
  { pattern: /[؀-ۿ]/, lang: 'ar-AE' },  // Arabic (disabled — routes to clean miss)
  // Devanagari last — shared by hi-IN and mr-IN, default to hi-IN
  { pattern: /[ऀ-ॿ]/, lang: 'hi-IN' },
];

// es-ES is disabled, but we still detect Spanish with a STRICT pattern so
// Spanish phrases route to the empty es-ES set and return a clean miss instead
// of bleeding into an active Indian-language term via multilingual embeddings.
// Only high-signal Spanish tokens are listed — diacritics, ¿/¡, and words that
// never occur in romanized Hindi/Dravidian QSR phrases. Deliberately NO bare
// articles/prepositions (de/un/el/la/por/en) — those collide with romanized
// Indian phrases and would steal active-language input.
const SPANISH_PATTERN = /[ñáéíóúü¿¡]|\b(quiero|quisiera|quieres|dame|d[eé]me|p[oó]n(?:me|game)|qu[ií]tame|favor|gracias|cu[aá]nto|cuesta|cuenta|bocadillo|tortilla|cebolla|zumo|ensalada|refresco|croissant|mismo|misma)\b/i;

// Romanized Kannada markers — distinctive words absent in other Roman-script languages
// beku=want, kodi=give, maadi=do, haki=add(slang), beda=don't want,
// ondu/eradu/mooru=one/two/three, sigtaa/sikkutte=available, ideyaa=is there
const KANNADA_ROMAN = /\b(beku|kodi|maadi|haki|beda|ondu|eradu|mooru|naige|ideyaa|sikkutte|sigtaa|maadbekide|eshtu|aagutte)\b/i;

// Romanized Tamil markers — distinctive words absent in other Roman-script languages
// venum=want, kudunga=give, pannunga=do/make, maaro=give(slang),
// irukka=is there, kidaikuma=available, evvalavu=how much
const TAMIL_ROMAN = /\b(venum|kudunga|pannunga|maaro|irukka|kidaikuma|evvalavu|vennum|pannanum|sollunga)\b/i;

// Romanized Telugu markers
// kavali=want, ivvandi=give, cheyandi=do, undaa=is there, enta=how much
const TELUGU_ROMAN = /\b(kavali|ivvandi|cheyandi|undaa|dorukutundaa|enta|vaddhu|avutundi|cheppandi)\b/i;

/**
 * Detect the language of a phrase.
 * Returns a BCP-47 code from our supported set, or null if uncertain.
 * null means: skip the language filter, search the global corpus.
 */
export function detectLanguage(phrase: string): string | null {
  // 1. Non-Latin script ranges (fastest, highest confidence)
  for (const { pattern, lang } of SCRIPT_RANGES) {
    if (pattern.test(phrase)) return lang;
  }

  // 2. Spanish (strict markers) → es-ES (disabled → routes to clean miss)
  if (SPANISH_PATTERN.test(phrase)) return 'es-ES';

  // 3. Romanized Dravidian markers (code-mixed phrases in Roman script)
  if (KANNADA_ROMAN.test(phrase)) return 'kn-IN';
  if (TAMIL_ROMAN.test(phrase)) return 'ta-IN';
  if (TELUGU_ROMAN.test(phrase)) return 'te-IN';

  return null;
}
