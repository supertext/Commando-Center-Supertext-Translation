import { NextResponse } from 'next/server';
import { latestReleases } from '@/lib/releases';
import { RateLimiter, clientIp } from '@/lib/rate-limit';
import { checkStatsToken, computeStats, loadStatsRows } from '@/lib/stats';

export const dynamic = 'force-dynamic';

const perIp = new RateLimiter(60, 60_000);
// Wrong tokens: a few per minute and address, so a token can't be guessed.
const failures = new RateLimiter(10, 60_000);

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/**
 * GET /api/v1/stats — totals per plugin (installations, versions, CMS versions, runtimes, key status).
 * Needs `Authorization: Bearer <COMMANDO_STATS_TOKEN>`; off while that variable isn't set.
 * `?local=1` includes local and test installations. No site URLs, clients or notes.
 */
export async function GET(req: Request) {
  const ip = clientIp(req.headers);
  if (!perIp.take(ip)) return json(429, { ok: false, error: 'Too many requests; try again in a minute.' });

  const auth = checkStatsToken(req.headers.get('authorization'));
  if (auth === 'off') return json(404, { ok: false, error: 'The statistics API is turned off.' });
  if (auth !== 'ok') {
    if (!failures.take(ip)) return json(429, { ok: false, error: 'Too many failed attempts; try again in a minute.' });
    return json(401, { ok: false, error: 'Send the statistics token as Authorization: Bearer <token>.' }, { 'WWW-Authenticate': 'Bearer' });
  }

  const includeLocal = new URL(req.url).searchParams.get('local') === '1';
  try {
    const rows = await loadStatsRows(includeLocal);
    const latest = await latestReleases(rows.map((r) => r.plugin));
    return json(200, { ok: true, ...computeStats(rows, latest, includeLocal) });
  } catch (e) {
    console.error('stats: could not load', e instanceof Error ? e.message : e);
    return json(503, { ok: false, error: 'Could not load the statistics; try again later.' });
  }
}
