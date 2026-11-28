/**
 * CSP violation reports from browsers (POST /api/v1/csp-report). Two formats arrive:
 * - the Reporting API (`Reporting-Endpoints` + `report-to`): application/reports+json, an array of
 *   { type: 'csp-violation', url, body: { documentURL, blockedURL, effectiveDirective, … } };
 * - the older `report-uri`: application/csp-report, { 'csp-report': { 'document-uri', 'blocked-uri',
 *   'effective-directive' | 'violated-directive', … } }.
 * Only reports for our own hosts are kept (CSP_REPORT_SITES or COMMANDO_CSP_SITES), and only the
 * page's origin and path and the blocked resource's origin: never query strings or fragments, which
 * can carry tokens (Wix's ?instance=, Shopify's id_token, review links' #token).
 */
export const MAX_CSP_BODY_BYTES = 64 * 1024;
export const MAX_REPORTS_PER_REQUEST = 20;

/** Our hosts whose pages send reports here. */
export const CSP_REPORT_SITES = [
  'pluginhealth.supertext.com',
  'integrations.supertext.com',
  'hubspot-production-ac4d.up.railway.app',
  'mailchimp-production.up.railway.app',
  'shopify-production-d86d.up.railway.app',
  'wix-production.up.railway.app',
  'localizationreview-production.up.railway.app',
  'agent-toolbox-production.up.railway.app',
];

export interface CspViolation {
  /** The page's host. */
  site: string;
  /** The page's path (no query, no fragment), at most 200 characters. */
  page: string;
  /** The directive that blocked it (script-src-elem, style-src-attr, frame-ancestors, …). */
  directive: string;
  /** What was blocked: an origin, or inline, eval, data, blob, self, wasm-eval, trusted-types-sink, unknown. */
  blocked: string;
  /** Enforced (true) or report-only (false). */
  enforced: boolean;
}

const KEYWORDS = new Set(['inline', 'eval', 'data', 'blob', 'self', 'wasm-eval', 'trusted-types-policy', 'trusted-types-sink']);

const str = (v: unknown, max = 2048): string => (typeof v === 'string' ? v.slice(0, max) : '');

function pageOf(value: string): { site: string; page: string } | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { site: u.hostname.toLowerCase(), page: (u.pathname || '/').slice(0, 200) };
  } catch {
    return null;
  }
}

function blockedOf(value: string): string {
  const v = value.trim().toLowerCase();
  if (!v) return 'unknown';
  if (KEYWORDS.has(v)) return v;
  try {
    const u = new URL(value);
    if (u.protocol === 'data:') return 'data';
    if (u.protocol === 'blob:') return 'blob';
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'wss:' || u.protocol === 'ws:') return u.origin.slice(0, 200);
    return `${u.protocol.replace(/:$/, '')}:`.slice(0, 40);
  } catch {
    return 'unknown';
  }
}

function directiveOf(value: string): string {
  // `violated-directive` can carry the whole directive ("script-src 'self' …"): the name only.
  const name = value.trim().split(/\s/)[0]?.toLowerCase() ?? '';
  return /^[a-z-]{1,40}$/.test(name) ? name : 'unknown';
}

function one(document: string, blocked: string, directive: string, enforced: boolean, sites: ReadonlySet<string>): CspViolation | null {
  const page = pageOf(document);
  if (!page || !sites.has(page.site)) return null;
  return { ...page, directive: directiveOf(directive), blocked: blockedOf(blocked), enforced };
}

/** The violations in a report body (both formats); unknown hosts and malformed entries are dropped. */
export function parseCspReports(body: unknown, sites: ReadonlySet<string> = new Set(CSP_REPORT_SITES)): CspViolation[] {
  const out: CspViolation[] = [];
  if (Array.isArray(body)) {
    for (const r of body.slice(0, MAX_REPORTS_PER_REQUEST)) {
      if (!r || typeof r !== 'object' || (r as { type?: unknown }).type !== 'csp-violation') continue;
      const b = (r as { body?: Record<string, unknown> }).body ?? {};
      const v = one(str(b.documentURL) || str((r as { url?: unknown }).url), str(b.blockedURL), str(b.effectiveDirective), b.disposition !== 'report', sites);
      if (v) out.push(v);
    }
  } else if (body && typeof body === 'object' && 'csp-report' in body) {
    const b = (body as { 'csp-report': Record<string, unknown> })['csp-report'] ?? {};
    const v = one(str(b['document-uri']), str(b['blocked-uri']), str(b['effective-directive']) || str(b['violated-directive']), b.disposition !== 'report', sites);
    if (v) out.push(v);
  }
  return out;
}

/** The report sites: COMMANDO_CSP_SITES (comma-separated hosts) or the built-in list. */
export function cspReportSites(env: string | undefined = process.env.COMMANDO_CSP_SITES): Set<string> {
  const list = (env ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set(list.length ? list : CSP_REPORT_SITES);
}
