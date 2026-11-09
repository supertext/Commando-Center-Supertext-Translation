import type { LanguageMapping } from './report';

/** Sorted for display: by the system's code. */
export function sortLanguages(list: LanguageMapping[]): LanguageMapping[] {
  return [...list].sort((a, b) => a.code.localeCompare(b.code, 'en', { sensitivity: 'base' }));
}

/**
 * What changed between two language mappings, for the history: languages added or removed, and a
 * changed Supertext code. `limit` caps the list; the rest is summed up as "N more changes".
 */
export function languageChanges(before: LanguageMapping[] | null, after: LanguageMapping[], limit = 6): string[] {
  const label = (l: LanguageMapping) => `${l.code} → ${l.supertext ?? 'not mapped'}`;
  if (before === null) return [`${after.length} ${after.length === 1 ? 'language' : 'languages'} sent`];
  const old = new Map(before.map((l) => [l.code.toLowerCase(), l]));
  const out: string[] = [];
  for (const l of sortLanguages(after)) {
    const o = old.get(l.code.toLowerCase());
    old.delete(l.code.toLowerCase());
    if (!o) out.push(`+ ${label(l)}`);
    else if (o.supertext !== l.supertext) out.push(`${l.code}: ${o.supertext ?? 'not mapped'} → ${l.supertext ?? 'not mapped'}`);
  }
  for (const o of sortLanguages([...old.values()])) out.push(`− ${o.code}`);
  return out.length > limit ? [...out.slice(0, limit - 1), `${out.length - limit + 1} more changes`] : out;
}
