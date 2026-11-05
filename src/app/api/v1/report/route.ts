import { NextResponse, after } from 'next/server';
import { recordReport } from '@/lib/db';
import { pingInstallation } from '@/lib/pinger';
import { MAX_BODY_BYTES, parseReport } from '@/lib/report';
import { RateLimiter, clientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Per IP: generous for a shop saving settings a few times, tight enough to stop floods.
const perIp = new RateLimiter(60, 60_000);

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /api/v1/report — a plugin reports its version (spec/report-v1.schema.json).
 * Public by design: plugins carry no credentials for the center. Responses are small JSON;
 * clients ignore the body (later versions may add fields, e.g. remote checks to run).
 */
export async function POST(req: Request) {
  if (!perIp.take(clientIp(req.headers))) {
    return json(429, { ok: false, error: 'Too many reports from this address; try again in a minute.' });
  }
  const type = req.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) {
    return json(415, { ok: false, error: 'Send JSON (Content-Type: application/json).' });
  }
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return json(413, { ok: false, error: 'Report too large.' });
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(413, { ok: false, error: 'Report too large.' });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: 'Body is not valid JSON.' });
  }
  const parsed = parseReport(body);
  if (!parsed.ok) return json(400, { ok: false, error: parsed.error });

  let installationId: number;
  try {
    ({ installationId } = await recordReport(parsed.report));
  } catch (e) {
    console.error('report: could not store', parsed.report.siteUrl, parsed.report.plugin, e instanceof Error ? e.message : e);
    return json(503, { ok: false, error: 'Could not store the report; try again later.' });
  }
  // The callback ping runs after the answer is sent, so it never slows the plugin down.
  if (parsed.report.callbackUrl) schedule(() => pingInstallation(installationId, 'report', parsed.report.event));
  return json(202, { ok: true });
}

function schedule(task: () => Promise<unknown>) {
  const run = () =>
    task().catch((e) => console.error('ping: failed', e instanceof Error ? e.message : e));
  try {
    after(run);
  } catch {
    void run(); // outside a request scope (tests)
  }
}

export function GET() {
  return json(405, { ok: false, error: 'POST a version report here; see the Plugin Health developer guide.' });
}
