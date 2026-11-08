import type { Extension } from './report';

function id(e: Extension): string {
  return `${e.type ?? ''}\u0000${e.name.toLowerCase()}`;
}

/** Sorted for display: active ones first, then by type and name. */
export function sortExtensions(list: Extension[]): Extension[] {
  return [...list].sort(
    (a, b) =>
      Number(b.active === true) - Number(a.active === true) ||
      (a.type ?? '').localeCompare(b.type ?? '') ||
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  );
}

/**
 * What changed between two lists of installed plugins, for the history: added, removed, updated,
 * activated, deactivated. `limit` caps the list; the rest is summed up as "N more changes".
 */
export function extensionChanges(before: Extension[] | null, after: Extension[], limit = 6): string[] {
  if (before === null) return [`${after.length} installed ${after.length === 1 ? 'plugin' : 'plugins'} sent`];
  const old = new Map(before.map((e) => [id(e), e]));
  const out: string[] = [];
  for (const e of sortExtensions(after)) {
    const o = old.get(id(e));
    old.delete(id(e));
    if (!o) {
      out.push(`+ ${e.name}${e.version ? ` ${e.version}` : ''}${e.active === false ? ' (inactive)' : ''}`);
      continue;
    }
    if (o.version !== e.version) out.push(`${e.name} ${o.version ?? '–'} → ${e.version ?? '–'}`);
    if (o.active !== e.active && e.active !== null) out.push(`${e.name} ${e.active ? 'activated' : 'deactivated'}`);
  }
  for (const o of sortExtensions([...old.values()])) out.push(`− ${o.name}`);
  return out.length > limit ? [...out.slice(0, limit - 1), `${out.length - limit + 1} more changes`] : out;
}
