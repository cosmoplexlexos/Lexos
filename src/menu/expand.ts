// ──────────────────────────────────────────────────────────
// Menu surface-form expansion.
//
// A menu item carries many spoken forms: the English name, the same name in
// each language, and colloquial/romanized aliases ("benne masale dose",
// "ಮಸಾಲ ದೋಸೆ", "masala dose" → all "Masala Dosa"). Matching must hit ANY of
// them and resolve to the one canonical name. So each surface form becomes its
// own menu_items row, all sharing the canonical `name`. The matcher then
// returns the canonical name regardless of which form the customer used.
// ──────────────────────────────────────────────────────────

export interface RawMenuItem {
  name:      string;            // canonical (English) name
  category?: string | null;
  price?:    number | null;
  names?:    string[];          // same item in other languages (native script)
  aliases?:  string[];          // colloquial / romanized / abbreviations
}

export interface ExpandedForm {
  name:     string;             // canonical name (returned on match)
  category: string | null;
  price:    number | null;
  text:     string;             // the surface form to embed
}

export function expandMenuItems(items: RawMenuItem[]): ExpandedForm[] {
  const out: ExpandedForm[] = [];
  for (const it of items) {
    if (!it || typeof it.name !== 'string' || !it.name.trim()) continue;
    const canonical = it.name.trim();
    const forms = new Set<string>([canonical]);
    for (const n of it.names ?? [])   if (typeof n === 'string' && n.trim()) forms.add(n.trim());
    for (const a of it.aliases ?? []) if (typeof a === 'string' && a.trim()) forms.add(a.trim());
    for (const text of forms) {
      out.push({ name: canonical, category: it.category ?? null, price: it.price ?? null, text });
    }
  }
  return out;
}
