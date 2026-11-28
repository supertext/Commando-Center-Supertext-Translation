import { NextResponse } from 'next/server';
import { recordCspViolations } from '@/lib/db';
import { MAX_CSP_BODY_BYTES, cspReportSites, parseCspReports } from '@/lib/csp-report';
import { RateLimiter, clientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Per IP: a page with a broken policy reports every violation, so more than the version reports.
const perIp = new RateLimiter(120, 60_000);
const sites = cspReportSites();

const empty = (status: number) => new NextResponse(null, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * POST /api/v1/csp-report — browsers report what the Content-Security-Policy of our own pages blocked
 * (Reporting API and the older report-uri). Public by design; only our hosts count, and only origins
 * and paths are kept (src/lib/csp-report.ts). Always 204 for a readable report, so pages learn nothing.
 */
export async function POST(req: Request) {
  if (!perIp.take(clientIp(req.headers))) return empty(429);
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!/application\/(reports\+json|csp-report|json)/.test(type)) return empty(415);
  if (Number(req.headers.get('content-length') ?? 0) > MAX_CSP_BODY_BYTES) return empty(413);
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_CSP_BODY_BYTES) return empty(413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return empty(400);
  }
  const violations = parseCspReports(body, sites);
  if (violations.length) {
    try {
      await recordCspViolations(violations);
    } catch (e) {
      console.error('csp-report: could not store', e instanceof Error ? e.message : e);
      return empty(503);
    }
  }
  return empty(204);
}

export function GET() {
  return NextResponse.json({ ok: false, error: 'Browsers POST CSP violation reports here.' }, { status: 405 });
}
