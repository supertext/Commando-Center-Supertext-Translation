// Contract: every report Supertext Plugin Health builds (plugin-health/spec/reporter.json scenarios,
// TypeScript reference implementation) is accepted by the center's parser, and the ping endpoint's
// answers pass the center's callback check.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseReport } from '../../src/lib/report';
import { InstallationReporter, pingResponse, reporterState, type KeyChecker } from '../../plugin-health/typescript/src/index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const spec = read('../../plugin-health/spec/reporter.json');
const callback = read('../../spec/callback-vectors.json');

describe('Plugin Health → center', () => {
  for (const scenario of spec.scenarios) {
    it(scenario.name, async () => {
      const { extensions: configExtensions, ...config } = { ...spec.config, ...scenario.config };
      let state = reporterState(scenario.state);
      for (const step of scenario.steps) {
        const bodies: Record<string, unknown>[] = [];
        const queue = step.keyChecks ? [...step.keyChecks] : null;
        const keyChecker: KeyChecker = { check: () => (queue ? queue.shift() : step.keyCheck), fingerprint: (k) => spec.fingerprints[k] };
        const keys = step.apiKeys ?? step.apiKey;
        const reporter = new InstallationReporter({
          ...config,
          keyChecker,
          reportUrl: 'https://center.test/api/v1/report',
          now: () => Date.parse(step.now),
          ...(configExtensions ? { extensions: () => configExtensions } : {}),
          fetch: async (_url, init) => {
            bodies.push(JSON.parse(init.body));
            if (step.report?.transportError) throw new TypeError('fetch failed');
            return { status: step.report?.status ?? 202 };
          },
        });
        const r =
          step.action === 'afterSettingsSaved'
            ? await reporter.afterSettingsSaved(state, keys)
            : step.action === 'onRequest'
              ? await reporter.onRequest(state, keys)
              : step.action === 'authenticationFailed'
                ? await reporter.authenticationFailed(state, keys, step.httpStatus, step.keyName)
                : step.action === 'testConnection'
                  ? await reporter.testConnection(state, keys)
                  : step.action === 'sendExtensions'
                    ? await reporter.sendExtensions(state, step.extensions)
                    : await reporter.reportCheck(state);
        for (const body of bodies) {
          const parsed = parseReport(body, Date.parse(step.now));
          expect(parsed.ok, JSON.stringify(body)).toBe(true);
          if (parsed.ok && body.api_key_check) expect(parsed.report.apiKeyCheck?.status).toBe((body.api_key_check as { status: string }).status);
          if (parsed.ok && config.callbackUrl) expect(parsed.report.callbackUrl).toBe(config.callbackUrl);
          if (parsed.ok && body.extensions) {
            const sent = body.extensions as { name: string; version?: string; active?: boolean; type?: string }[];
            expect(parsed.report.extensions).toEqual(sent.map((e) => ({ name: e.name, version: e.version ?? null, active: e.active ?? null, type: e.type ?? null })));
          }
          if (parsed.ok && body.api_keys) {
            const sent = body.api_keys as { name: string; check: { status: string } }[];
            expect(parsed.report.apiKeys?.map((k) => [k.name, k.check?.status])).toEqual(sent.map((k) => [k.name, k.check.status]));
          }
        }
        state = r.state;
      }
    });
  }

  it('the ping endpoint answers what the center expects', () => {
    for (const c of callback.endpoint.cases) {
      const r = pingResponse(c.challenge, { plugin: 'Grav-Supertext-Translation', enabled: true });
      expect(r.status).toBe(c.status);
      expect(r.headers['Cache-Control']).toBe('no-store');
      if (c.status === 200) expect(JSON.parse(r.body)).toEqual({ ok: true, plugin: 'Grav-Supertext-Translation', challenge: c.challenge });
    }
  });
});
