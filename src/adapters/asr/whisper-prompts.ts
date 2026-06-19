import { LanguageConfig } from '../../types';

// ──────────────────────────────────────────────────────────
// Language registry + Whisper initial_prompt builder.
// (Relocated out of the retired generation module; used by the
//  /retrieve/asr-bias Whisper adapter.)
// ──────────────────────────────────────────────────────────

export const LANGUAGES: LanguageConfig[] = [
  { code: 'hi-IN', name: 'Hindi',   nativeName: 'हिंदी',   scriptNote: 'Devanagari + natural Hinglish.' },
  { code: 'kn-IN', name: 'Kannada', nativeName: 'ಕನ್ನಡ',   scriptNote: 'Kannada script + Kanglish.' },
  { code: 'mr-IN', name: 'Marathi', nativeName: 'मराठी',   scriptNote: 'Devanagari + Marathi-English mix.' },
  { code: 'ta-IN', name: 'Tamil',   nativeName: 'தமிழ்',   scriptNote: 'Tamil script + Tanglish.' },
  { code: 'te-IN', name: 'Telugu',  nativeName: 'తెలుగు',  scriptNote: 'Telugu script + Telugu-English mix.' },
];

/** Builds a Whisper initial_prompt narrative (≤~200 tokens) from phrase shapes. */
export function buildWhisperPrompt(lang: LanguageConfig, phoneticPhrases: string[]): string {
  const maxWords = 130;
  const selected: string[] = [];
  let wordCount = 0;
  for (const phrase of phoneticPhrases) {
    const words = phrase.split(' ').length;
    if (wordCount + words > maxWords) break;
    selected.push(phrase);
    wordCount += words;
  }
  return `${lang.name} restaurant ordering. Customer phrases: ${selected.join(', ')}.`;
}
