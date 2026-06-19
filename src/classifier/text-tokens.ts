// Shared tokenizer for the action-cue gate and vocab building.
// Lowercase, split on whitespace + common punctuation (incl. Devanagari danda).
// Native-script words are whitespace-delimited, so this works across scripts.
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s,.!?;:।॥|()"'`\-/]+/)
    .map(t => t.trim())
    .filter(Boolean);
}
