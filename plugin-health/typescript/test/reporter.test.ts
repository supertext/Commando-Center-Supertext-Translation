// ../spec/reporter.json and the dashboard's ping cases (spec/callback-vectors.json). That the
// center accepts every report body is checked in the center's own tests (test/unit/plugin-health.test.ts).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPORT_URL,
  FAILURE_BACKOFF_MS,
  InstallationReporter,
  PLUGIN_HEALTH_VERSION,
  REPORT_TIMEOUT_MS,
  keyCheck,
  pingResponse,
  reporterState,
  reportsEnabled,
  type FetchLike,
  type KeyCheck,
  type KeyChecker,
  type ReporterState,
} from '../src/index.js'

const read = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const s = read('../../spec/reporter.json')
const center = (name: string): any => read(`../../../spec/${name}`)
const pkg = read('../package.json')

type Answer = { status?: number; transportError?: boolean } | null | undefined

/** Fake key checker (returns the step's keyCheck) and fake center; records the calls in order. */
function fakes(stepCheck: KeyCheck | undefined, report: Answer) {
  const calls: string[] = []
  const bodies: Record<string, unknown>[] = []
  const headers: Record<string, string>[] = []
  const keyChecker: KeyChecker = {
    check: async () => {
      calls.push('keyCheck')
      if (!stepCheck) throw new Error('unexpected key check')
      return stepCheck
    },
    fingerprint: (apiKey) => {
      const fp = s.fingerprints[apiKey]
      if (fp === undefined) throw new Error(`no fingerprint for ${JSON.stringify(apiKey)}`)
      return fp
    },
  }
  const fetch: FetchLike = async (url, init) => {
    calls.push('report')
    expect(url).toBe('https://center.test/api/v1/report')
    expect(init.method).toBe('POST')
    bodies.push(JSON.parse(init.body))
    headers.push(init.headers)
    if (!report) throw new Error('unexpected report')
    if (report.transportError) throw new TypeError('fetch failed')
    return new Response(null, { status: report.status ?? 202 })
  }
  return { keyChecker, fetch, calls, bodies, headers }
}

describe('spec/reporter.json', () => {
  it('has the same defaults', () => {
    expect(DEFAULT_REPORT_URL).toBe(s.defaults.reportUrl)
    expect(REPORT_TIMEOUT_MS).toBe(s.defaults.reportTimeoutSeconds * 1000)
    expect(FAILURE_BACKOFF_MS).toBe(s.defaults.failureBackoffSeconds * 1000)
    expect(PLUGIN_HEALTH_VERSION).toBe(pkg.version)
  })

  for (const c of s.enabled) it(`enabled ${JSON.stringify(c)}`, () => expect(reportsEnabled(c.setting, c.env)).toBe(c.out))

  for (const c of s.ping.cases) {
    it(`ping ${JSON.stringify(c.challenge)} enabled=${c.enabled}`, () => {
      const r = pingResponse(c.challenge, { plugin: s.ping.plugin, enabled: c.enabled })
      expect(r.status).toBe(c.status)
      expect(JSON.parse(r.body)).toEqual(c.body)
      expect(r.headers).toEqual({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    })
  }

  for (const scenario of s.scenarios) {
    it(scenario.name, async () => {
      const config = { ...s.config, ...scenario.config }
      let state: ReporterState = reporterState(JSON.parse(JSON.stringify(scenario.state)))
      for (const step of scenario.steps) {
        const f = fakes(step.keyCheck, step.report)
        const reporter = new InstallationReporter({
          ...config,
          keyChecker: f.keyChecker,
          reportUrl: 'https://center.test/api/v1/report',
          fetch: f.fetch,
          now: () => Date.parse(step.now),
        })
        const r =
          step.action === 'afterSettingsSaved'
            ? await reporter.afterSettingsSaved(state, step.apiKey)
            : step.action === 'onRequest'
              ? await reporter.onRequest(state, step.apiKey)
              : step.action === 'authenticationFailed'
                ? await reporter.authenticationFailed(state, step.apiKey, step.httpStatus)
                : step.action === 'testConnection'
                  ? await reporter.testConnection(state, step.apiKey)
                  : await reporter.reportCheck(state)
        expect(f.calls, step.action).toEqual(step.expect.calls)
        expect(r.event).toBe(step.expect.event)
        expect(r.sent).toBe(step.expect.sent)
        expect(r.check).toEqual(step.expect.check)
        expect(r.state).toEqual(step.expect.state)
        if (step.expect.reportBody) expect(f.bodies[0]).toEqual(step.expect.reportBody)
        for (const h of f.headers) expect(h['User-Agent']).toBe(`supertext-plugin-health/${PLUGIN_HEALTH_VERSION} (typescript) ${config.plugin.name}/${config.plugin.version}`)
        // The stored form survives a JSON round trip.
        state = reporterState(JSON.stringify(r.state))
        expect(state).toEqual(step.expect.state)
      }
    })
  }
})

describe("the center's spec", () => {
  const callback = center('callback-vectors.json')
  for (const c of callback.endpoint.cases) {
    it(`ping endpoint ${JSON.stringify(c.challenge)}`, () => {
      const r = pingResponse(c.challenge, { plugin: 'Some-Supertext-Translation', enabled: true })
      expect(r.status).toBe(c.status)
      const expected = c.body.plugin ? { ...c.body, plugin: 'Some-Supertext-Translation' } : c.body
      expect(JSON.parse(r.body)).toEqual(expected)
    })
  }

  it('builds reports with the fields of the center schema', () => {
    const schema = center('report-v1.schema.json')
    const reporter = new InstallationReporter({ ...s.config, keyChecker: fakes(undefined, null).keyChecker })
    const body = reporter.buildReport('settings_saved', reporterState(null))
    for (const field of schema.required) expect(body).toHaveProperty(field)
    for (const field of Object.keys(body)) expect(schema.properties).toHaveProperty(field)
  })
})

describe('reporter', () => {
  const okCheck: KeyCheck = { status: 'ok', checkedAt: '2026-10-13T08:00:00Z', httpStatus: 200, errorCode: null, fingerprint: 'abc' }

  it('never sends the key', async () => {
    const f = fakes(okCheck, { status: 202 })
    const reporter = new InstallationReporter({ ...s.config, keyChecker: { ...f.keyChecker, fingerprint: () => 'abc' }, reportUrl: 'https://center.test/api/v1/report', fetch: f.fetch })
    await reporter.afterSettingsSaved(null, 'secret-key-123')
    expect(JSON.stringify(f.bodies)).not.toContain('secret-key-123')
    expect(JSON.stringify(f.bodies)).not.toContain('"abc"') // nor the fingerprint
  })

  it('a checker that throws gives an error check, not an exception', async () => {
    const reporter = new InstallationReporter({
      ...s.config,
      enabled: false,
      keyChecker: { check: () => { throw new Error('boom') }, fingerprint: () => 'fp' },
      now: () => Date.parse('2026-10-13T08:00:00.700Z'),
    })
    const r = await reporter.afterSettingsSaved(null, 'k')
    expect(r.check).toEqual({ status: 'error', checkedAt: '2026-10-13T08:00:00Z', httpStatus: null, errorCode: null, fingerprint: 'fp' })
  })

  it('accepts any object with the KeyCheck fields (the SDK\'s ApiKeyCheck)', () => {
    expect(keyCheck({ ...okCheck, extra: 1 })).toEqual(okCheck)
    expect(keyCheck({ status: 'ok' })).toBeNull()
  })

  it('without an SDK version the report has no sdk_version', () => {
    const reporter = new InstallationReporter({ ...s.config, sdkVersion: null, keyChecker: fakes(undefined, null).keyChecker })
    const body = reporter.buildReport('check', reporterState(null))
    expect(body).not.toHaveProperty('sdk_version')
  })

  it('treats a broken stored state as empty', () => {
    expect(reporterState('not json')).toEqual({ reportedVersions: null, reportedKeyStatus: null, lastFailureAt: null, keyCheck: null })
    expect(reporterState(null).keyCheck).toBeNull()
  })

  it('reads a state stored by the Supertext SDK 0.1–0.2 reporter', () => {
    const old = '{"reportedVersions":"0.2.0|12.0.0|22.11.0","reportedKeyStatus":"ok","lastFailureAt":null,"keyCheck":{"status":"ok","checkedAt":"2026-10-13T08:00:00Z","httpStatus":200,"errorCode":null,"fingerprint":"abc"}}'
    expect(reporterState(old)).toEqual({ reportedVersions: '0.2.0|12.0.0|22.11.0', reportedKeyStatus: 'ok', lastFailureAt: null, keyCheck: okCheck })
  })

  it('detects the runtime', () => {
    const reporter = new InstallationReporter({ ...s.config, runtime: undefined, keyChecker: fakes(undefined, null).keyChecker })
    expect(reporter.buildReport('check', reporterState(null)).runtime).toEqual({ name: 'Node.js', version: process.versions.node })
  })
})
