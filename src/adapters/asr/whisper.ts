import { PhoneticVariant } from '../../db/queries/retrieve';
import { buildWhisperPrompt, LANGUAGES } from './whisper-prompts';

// ──────────────────────────────────────────────────────────
// Whisper adapter — initial_prompt narrative
//
// Reuses buildWhisperPrompt from the generation module.
// Output: a coherent narrative of ≤200 tokens that Whisper
// uses as context to bias its transcription toward QSR terms.
// ──────────────────────────────────────────────────────────

export interface WhisperPayload {
  initial_prompt: string;
}

/**
 * Formats PHONETIC variants into a Whisper initial_prompt narrative.
 *
 * Uses COLLOQUIAL/CODE_MIXED phrase shapes (romanised) so Whisper
 * recognises the expected vocabulary in natural speech patterns.
 * Capped at ≈200 tokens (130 words + framing) as per Whisper spec.
 */
export function formatWhisperPayload(
  lang:     string,
  variants: PhoneticVariant[],
): WhisperPayload {
  const langConfig = LANGUAGES.find(l => l.code === lang);

  // Graceful fallback if language isn't in the registry
  if (!langConfig) {
    const phrases = variants.map(v => v.value);
    const initial_prompt =
      `Restaurant ordering. Customer phrases: ${phrases.slice(0, 50).join(', ')}.`;
    return { initial_prompt };
  }

  const phrases = variants.map(v => v.value);
  const initial_prompt = buildWhisperPrompt(langConfig, phrases);
  return { initial_prompt };
}
