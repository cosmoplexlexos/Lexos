// ──────────────────────────────────────────────────────────
// Shared types used across the live codebase (db queries, ASR adapter).
// (Relocated out of the retired generation module.)
// ──────────────────────────────────────────────────────────

export type VariantType = 'FORMAL' | 'COLLOQUIAL' | 'CODE_MIXED' | 'PHONETIC';
export type Tier = 'A' | 'B' | 'C';

/** A canonical intent record (intent_id, name, domain). */
export interface QsrIntent {
  intent_id: string;
  intent_name: string;
  domain: string;
  examples?: string[];
}

/** A single phrase variant of a term. */
export interface GeneratedVariant {
  type: VariantType;
  value: string;
  confidence: number;   // 0.0 – 1.0
}

/** Per-language config (script notes drive the Whisper ASR prompt). */
export interface LanguageConfig {
  code: string;         // BCP-47 e.g. "hi-IN"
  name: string;         // English e.g. "Hindi"
  nativeName: string;   // native script
  scriptNote: string;
}
