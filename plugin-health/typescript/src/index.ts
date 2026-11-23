/**
 * Supertext Plugin Health: version reports to the Supertext Plugin Health dashboard, the API key check
 * result and the plugin's ping endpoint (../spec/reporter.json; protocol: the dashboard's
 * docs/DEVELOPER.md → Report protocol).
 *
 * The reporter is stateless: the plugin loads its `ReporterState` (a plain JSON object), passes it
 * in, and stores the state it gets back. It never talks to Supertext itself: the plugin passes a
 * key checker built on the Supertext SDK (`client.checkApiKey()` and `apiKeyFingerprint()`).
 *
 * One key: pass it as a string (reported as api_key_configured and api_key_check). Several keys
 * (e.g. AI translation and professional orders): pass `{ name: key }` in the order the settings show
 * them; each is checked and reported by name in api_keys.
 */

import config from './config.json' with { type: 'json' }

export const PLUGIN_HEALTH_VERSION = '0.4.0'
/** The live Plugin Health dashboard, from config.json (plugin-health/config.json). SUPERTEXT_REPORT_URL overrides it. */
export const DEFAULT_REPORT_URL: string = config.reportUrl
export const REPORT_TIMEOUT_MS = 3_000
export const FAILURE_BACKOFF_MS = 3_600_000

export type ReportEvent = 'installed' | 'settings_saved' | 'upgraded' | 'api_key_check' | 'check' | 'extensions' | 'languages'

/** The result of the SDK's API key check, as the reporter stores and reports it. */
export interface KeyCheck {
  /** `ok`, `invalid`, `missing`, `unreachable` or `error` (the SDK's statuses). */
  status: string
  /** When the check ran: UTC ISO 8601 without fractions (`2026-10-13T08:00:00Z`). */
  checkedAt: string
  /** The HTTP status Supertext answered with; null without an answer. */
  httpStatus: number | null
  /** Supertext's `error_code`; null if none. */
  errorCode: string | null
  /** SHA-256 of the key, to notice a changed key. Kept locally, never sent. '' for a blank key. */
  fingerprint: string
}

/**
 * How the reporter checks the API key. Plugins pass the Supertext SDK's functions:
 * `{ check: (key) => new SupertextClient(key).checkApiKey(), fingerprint: apiKeyFingerprint }`
 * (the SDK's ApiKeyCheck has the same fields as KeyCheck).
 */
export interface KeyChecker {
  check(apiKey: string): Promise<KeyCheck> | KeyCheck
  fingerprint(apiKey: string): string
}

/** The plugin's API keys: one key as a string, or several by name (`{ 'AI translation': key, … }`, at most 20). */
export type ApiKeys = string | Readonly<Record<string, string>>

/** At most this many named keys are checked and reported; the rest are ignored. */
export const MAX_API_KEYS = 20

/** What the plugin stores between requests (as JSON, unchanged). */
export interface ReporterState {
  /** `<plugin>|<system>|<runtime>` versions last reported successfully. */
  reportedVersions: string | null
  /** The key status last reported successfully (one key). */
  reportedKeyStatus: string | null
  /** When the last report failed (no new attempt for an hour). */
  lastFailureAt: string | null
  /** The latest key check (one key). */
  keyCheck: KeyCheck | null
  /** Several keys: the latest check of each, by name, in the plugin's order; null with one key. */
  keyChecks: Record<string, KeyCheck> | null
  /** Several keys: the statuses last reported successfully, by name. */
  reportedKeyStatuses: Record<string, string> | null
}

/** Another plugin, extension, module or theme installed on the site (see `sendExtensions`). */
export interface Extension {
  /** As the system shows it, e.g. "Polylang Pro". */
  name: string
  version?: string | null
  /** Whether it is enabled; leave it out if the system doesn't say. */
  active?: boolean | null
  /** The system's own word: plugin, theme, module, extension, bundle, package, app, … */
  type?: string | null
}

/** At most this many installed plugins are sent; the rest are left out. */
export const MAX_EXTENSIONS = 500

/**
 * The list as it is sent: names and versions trimmed (100 and 50 characters), types in lower case
 * (30), blank names and repeats (same type and name, ignoring case) dropped, at most MAX_EXTENSIONS.
 */
export function normalizeExtensions(list: Iterable<Extension>): Extension[] {
  const out: Extension[] = []
  const seen = new Set<string>()
  for (const e of list) {
    if (out.length >= MAX_EXTENSIONS) break
    if (!e || typeof e !== 'object' || typeof e.name !== 'string') continue
    const name = e.name.trim().slice(0, 100)
    if (!name) continue
    const type = typeof e.type === 'string' ? e.type.trim().toLowerCase().slice(0, 30) : ''
    const id = `${type}\u0000${name.toLowerCase()}`
    if (seen.has(id)) continue
    seen.add(id)
    const entry: Extension = { name }
    const version = typeof e.version === 'string' ? e.version.trim().slice(0, 50) : ''
    if (version) entry.version = version
    if (typeof e.active === 'boolean') entry.active = e.active
    if (type) entry.type = type
    out.push(entry)
  }
  return out
}

/** One language of the system and the Supertext code it is translated as (see `sendLanguages`). */
export interface LanguageMapping {
  /** The system's own code, as it shows it: de_CH, en-GB, zh_Hans_CN, … */
  code: string
  /** The Supertext code the plugin uses for it (de-CH, fr-FR, zh-Hans, …); null or left out: not mapped. */
  supertext?: string | null
}

/** At most this many languages are sent; the rest are left out. */
export const MAX_LANGUAGES = 100

/**
 * The mapping as it is sent: codes trimmed and cut to 35 characters, a blank Supertext code sent as null,
 * blank codes and repeats (same code, ignoring case) dropped, at most MAX_LANGUAGES.
 */
export function normalizeLanguages(list: Iterable<LanguageMapping>): Array<{ code: string; supertext: string | null }> {
  const out: Array<{ code: string; supertext: string | null }> = []
  const seen = new Set<string>()
  for (const l of list) {
    if (out.length >= MAX_LANGUAGES) break
    if (!l || typeof l !== 'object' || typeof l.code !== 'string') continue
    const code = l.code.trim().slice(0, 35)
    if (!code || seen.has(code.toLowerCase())) continue
    seen.add(code.toLowerCase())
    const supertext = typeof l.supertext === 'string' ? l.supertext.trim().slice(0, 35) : ''
    out.push({ code, supertext: supertext || null })
  }
  return out
}

export interface NameVersion {
  name: string
  version?: string | null
}

/** What `fetch` the reporter needs (tests pass a fake). */
export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number
  body?: { cancel(): Promise<void> } | null
}>

export interface ReporterOptions {
  /** The "Send version information to Supertext" setting combined with the environment: see `reportsEnabled()`. */
  enabled: boolean
  /** Base URL of the installation, as the system knows it. */
  siteUrl: string
  /** `name` = the plugin's GitHub repository name; `version` from its official version source. */
  plugin: { name: string; version: string }
  /** The CMS, PIM, shop or application, in its own spelling. */
  system: NameVersion
  /** The bundled Supertext SDK's version (its `SDK_VERSION`), or null without the SDK. */
  sdkVersion: string | null
  /** The SDK's key check: see `KeyChecker`. */
  keyChecker: KeyChecker
  /** Default: Node.js (or Deno/Bun) and its version. */
  runtime?: NameVersion
  /** The plugin's public ping endpoint; null for hosted apps without one. */
  callbackUrl?: string | null
  /**
   * Optional: returns the installed plugins, so that every report carries them. Leave it out to send
   * them only by hand (`sendExtensions`, the plugin's button): the default. Only where the list is cheap.
   */
  extensions?: () => Iterable<Extension>
  /**
   * Optional: returns the language mapping, so that every report carries it. Leave it out to send it
   * only by hand (`sendLanguages`, the plugin's button): the default.
   */
  languages?: () => Iterable<LanguageMapping>
  /** Default: `SUPERTEXT_REPORT_URL` from the environment, else the live center. */
  reportUrl?: string
  /** HTTP for the report (tests). Default: the global `fetch`. */
  fetch?: FetchLike
  /** Clock in milliseconds (tests). */
  now?: () => number
}

export interface ReporterResult {
  /** Store this. */
  state: ReporterState
  /** The latest key check (show it on the settings or status page); null with several keys. */
  check: KeyCheck | null
  /** Several keys: the latest check of each, by name; null with one key. */
  checks: Record<string, KeyCheck> | null
  /** The event that was reported (or tried); null when nothing was due. */
  event: ReportEvent | null
  /** Whether the center accepted the report. */
  sent: boolean
}

export const EMPTY_REPORTER_STATE: ReporterState = Object.freeze({
  reportedVersions: null,
  reportedKeyStatus: null,
  lastFailureAt: null,
  keyCheck: null,
  keyChecks: null,
  reportedKeyStatuses: null,
})

/** A key check from any object with the KeyCheck fields (e.g. the SDK's ApiKeyCheck); null if it has none. */
export function keyCheck(value: unknown): KeyCheck | null {
  const k = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  if (!k || typeof k.status !== 'string' || typeof k.checkedAt !== 'string') return null
  return {
    status: k.status,
    checkedAt: k.checkedAt,
    httpStatus: typeof k.httpStatus === 'number' ? k.httpStatus : null,
    errorCode: typeof k.errorCode === 'string' ? k.errorCode : null,
    fingerprint: typeof k.fingerprint === 'string' ? k.fingerprint : '',
  }
}

/** A stored state (parsed JSON, a JSON string, or anything) as a `ReporterState`; unknown or broken values become empty. */
export function reporterState(value: unknown): ReporterState {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      value = null
    }
  }
  const o = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const s = (v: unknown) => (typeof v === 'string' ? v : null)
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
  let keyChecks: Record<string, KeyCheck> | null = null
  const kc = obj(o.keyChecks)
  if (kc) {
    keyChecks = {}
    for (const [name, value] of Object.entries(kc)) {
      const c = keyCheck(value)
      if (c) keyChecks[name] = c
    }
  }
  let reportedKeyStatuses: Record<string, string> | null = null
  const rk = obj(o.reportedKeyStatuses)
  if (rk) {
    reportedKeyStatuses = {}
    for (const [name, value] of Object.entries(rk)) if (typeof value === 'string') reportedKeyStatuses[name] = value
  }
  return {
    reportedVersions: s(o.reportedVersions),
    reportedKeyStatus: s(o.reportedKeyStatus),
    lastFailureAt: s(o.lastFailureAt),
    keyCheck: keyCheck(o.keyCheck),
    keyChecks,
    reportedKeyStatuses,
  }
}

/** The named keys as [name, key] pairs (at most MAX_API_KEYS, names trimmed, blank and repeated names dropped). */
function namedKeys(apiKeys: Readonly<Record<string, string>>): [string, string][] {
  const out: [string, string][] = []
  for (const [raw, key] of Object.entries(apiKeys)) {
    const name = raw.trim().slice(0, 60)
    if (!name || out.some(([n]) => n === name)) continue
    out.push([name, typeof key === 'string' ? key : ''])
    if (out.length >= MAX_API_KEYS) break
  }
  return out
}

/**
 * Whether version reports are on: `SUPERTEXT_VERSION_REPORTS` (0/false/off/no, 1/true/on/yes)
 * wins over the setting; the setting defaults to on.
 */
export function reportsEnabled(setting?: boolean | null, env: string | null | undefined = processEnv('SUPERTEXT_VERSION_REPORTS')): boolean {
  const value = (env ?? '').trim().toLowerCase()
  if (['0', 'false', 'off', 'no'].includes(value)) return false
  if (['1', 'true', 'on', 'yes'].includes(value)) return true
  return setting ?? true
}

const CHALLENGE = /^[A-Za-z0-9_-]{16,64}$/

export interface PingResponse {
  status: 200 | 400 | 404
  headers: Record<string, string>
  body: string
}

/**
 * The answer of the plugin's public ping endpoint (`GET <callback>?challenge=<c>`).
 * Only while reporting is on (else 404). Nothing a caller sends is reflected unless it matches the pattern.
 */
export function pingResponse(challenge: string | null | undefined, options: { plugin: string; enabled: boolean }): PingResponse {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  if (!options.enabled) return { status: 404, headers, body: '{"ok":false}' }
  if (typeof challenge !== 'string' || !CHALLENGE.test(challenge)) return { status: 400, headers, body: '{"ok":false}' }
  return { status: 200, headers, body: JSON.stringify({ ok: true, plugin: options.plugin, challenge }) }
}

export class InstallationReporter {
  readonly #options: ReporterOptions
  readonly #now: () => number
  readonly #fetch: FetchLike
  readonly reportUrl: string

  constructor(options: ReporterOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.reportUrl = options.reportUrl || processEnv('SUPERTEXT_REPORT_URL') || DEFAULT_REPORT_URL
  }

  /** Whether reports are sent (the ping endpoint answers only then). */
  get enabled(): boolean {
    return this.#options.enabled
  }

  /** `<plugin>|<system>|<runtime>` versions. */
  get versions(): string {
    return [this.#options.plugin.version, this.#options.system.version ?? '', this.#runtime().version ?? ''].join('|')
  }

  /** After the plugin's settings were saved: checks the key(s), reports `installed` or `settings_saved`. */
  async afterSettingsSaved(state: ReporterState | null, apiKeys: ApiKeys): Promise<ReporterResult> {
    const current = await this.#withChecks(state ?? EMPTY_REPORTER_STATE, apiKeys, true)
    return this.#reportIfDue(current, current.reportedVersions === null ? 'installed' : 'settings_saved')
  }

  /** On back-end requests that run the plugin's code: checks changed keys, reports what changed. */
  async onRequest(state: ReporterState | null, apiKeys: ApiKeys): Promise<ReporterResult> {
    const current = await this.#withChecks(state ?? EMPTY_REPORTER_STATE, apiKeys, false)
    return this.#reportIfDue(current, this.#dueEvent(current))
  }

  /**
   * A translation was rejected with 401/403: the key is invalid (no check against Supertext). With
   * several keys, `keyName` says which one (the others keep their result).
   */
  async authenticationFailed(state: ReporterState | null, apiKeys: ApiKeys, httpStatus = 401, keyName?: string | null): Promise<ReporterResult> {
    const invalid = (key: string): KeyCheck => ({
      status: 'invalid',
      checkedAt: isoSeconds(this.#now()),
      httpStatus,
      errorCode: null,
      fingerprint: this.#options.keyChecker.fingerprint(key),
    })
    const base = state ?? EMPTY_REPORTER_STATE
    let current: ReporterState
    if (typeof apiKeys === 'string') {
      current = { ...base, keyCheck: invalid(apiKeys), keyChecks: null, reportedKeyStatuses: null, reportedKeyStatus: base.keyChecks !== null ? null : base.reportedKeyStatus }
    } else {
      current = await this.#withChecks(base, apiKeys, false)
      const keyChecks = { ...(current.keyChecks ?? {}) }
      for (const [name, key] of namedKeys(apiKeys)) if (keyName == null || name === keyName.trim()) keyChecks[name] = invalid(key)
      current = { ...current, keyChecks }
    }
    return this.#reportIfDue(current, this.#dueEvent(current))
  }

  /** The "Test connection" button: checks the key(s), reports a change. */
  async testConnection(state: ReporterState | null, apiKeys: ApiKeys): Promise<ReporterResult> {
    const current = await this.#withChecks(state ?? EMPTY_REPORTER_STATE, apiKeys, true)
    return this.#reportIfDue(current, this.#dueEvent(current))
  }

  /** Sends a `check` report now (commands, tests), even after a recent failure. */
  async reportCheck(state: ReporterState | null): Promise<ReporterResult> {
    return this.#send(state ?? EMPTY_REPORTER_STATE, 'check')
  }

  /**
   * The plugin's "Send installed plugins to Supertext" button: sends event `extensions` with the list
   * now, even after a recent failure, but only while reporting is on (`sent` false otherwise).
   */
  async sendExtensions(state: ReporterState | null, extensions: Iterable<Extension>): Promise<ReporterResult> {
    return this.#send(state ?? EMPTY_REPORTER_STATE, 'extensions', normalizeExtensions(extensions))
  }

  /**
   * The plugin's "Send language settings to Supertext" button: sends event `languages` with the mapping
   * now, even after a recent failure, but only while reporting is on (`sent` false otherwise).
   */
  async sendLanguages(state: ReporterState | null, languages: Iterable<LanguageMapping>): Promise<ReporterResult> {
    return this.#send(state ?? EMPTY_REPORTER_STATE, 'languages', null, normalizeLanguages(languages))
  }

  /**
   * The report body for an event and state (`extensions`, `languages`: the lists to send; default: the
   * extensions and languages functions', if any).
   */
  buildReport(
    event: ReportEvent,
    state: ReporterState,
    extensions?: Extension[] | null,
    languages?: LanguageMapping[] | null,
  ): Record<string, unknown> {
    const o = this.#options
    const body: Record<string, unknown> = {
      schema: 1,
      event,
      site_url: o.siteUrl,
      plugin: { name: o.plugin.name, version: o.plugin.version },
      system: nameVersion(o.system),
      runtime: nameVersion(this.#runtime()),
    }
    if (o.sdkVersion) body.sdk_version = o.sdkVersion
    if (state.keyChecks) {
      body.api_keys = Object.entries(state.keyChecks).map(([name, check]) => ({ name, configured: check.fingerprint !== '', check: checkBody(check) }))
    } else if (state.keyCheck) {
      body.api_key_configured = state.keyCheck.fingerprint !== ''
      body.api_key_check = checkBody(state.keyCheck)
    }
    if (o.callbackUrl) body.callback = { url: o.callbackUrl }
    const list = extensions ?? this.#extensions()
    if (list) body.extensions = list
    const mapping = languages ? normalizeLanguages(languages) : this.#languages()
    if (mapping) body.languages = mapping
    return body
  }

  #languages(): Array<{ code: string; supertext: string | null }> | null {
    if (!this.#options.languages) return null
    try {
      return normalizeLanguages(this.#options.languages())
    } catch {
      return null // never fails the report: the mapping is extra information
    }
  }

  #extensions(): Extension[] | null {
    if (!this.#options.extensions) return null
    try {
      return normalizeExtensions(this.#options.extensions())
    } catch {
      return null // never fails the report: the list is extra information
    }
  }

  #runtime(): NameVersion {
    return this.#options.runtime ?? detectRuntime()
  }

  #dueEvent(state: ReporterState): ReportEvent | null {
    if (state.reportedVersions === null) return 'installed'
    if (state.reportedVersions !== this.versions) return 'upgraded'
    if (state.keyChecks !== null) {
      const reported = state.reportedKeyStatuses ?? {}
      const names = Object.keys(state.keyChecks)
      if (names.length !== Object.keys(reported).length || names.some((n) => state.keyChecks![n]!.status !== reported[n])) return 'api_key_check'
      return null
    }
    if (state.keyCheck !== null && state.keyCheck.status !== state.reportedKeyStatus) return 'api_key_check'
    return null
  }

  /** The state with fresh checks: always (`force`), else only for keys that are new or changed. */
  async #withChecks(state: ReporterState, apiKeys: ApiKeys, force: boolean): Promise<ReporterState> {
    const fp = (key: string) => this.#options.keyChecker.fingerprint(key)
    if (typeof apiKeys === 'string') {
      if (!force && state.keyChecks === null && state.keyCheck !== null && state.keyCheck.fingerprint === fp(apiKeys)) return state
      // Coming from several keys: report the single key even if its status is the one reported before.
      const reportedKeyStatus = state.keyChecks !== null ? null : state.reportedKeyStatus
      return { ...state, keyCheck: await this.#check(apiKeys), keyChecks: null, reportedKeyStatuses: null, reportedKeyStatus }
    }
    const keyChecks: Record<string, KeyCheck> = {}
    for (const [name, key] of namedKeys(apiKeys)) {
      const old = state.keyChecks?.[name]
      keyChecks[name] = !force && old && old.fingerprint === fp(key) ? old : await this.#check(key)
    }
    return { ...state, keyCheck: null, keyChecks }
  }

  async #check(apiKey: string): Promise<KeyCheck> {
    try {
      const check = keyCheck(await this.#options.keyChecker.check(apiKey))
      if (check) return check
    } catch {
      // the SDK's check never throws; a plugin's own checker might
    }
    return { status: 'error', checkedAt: isoSeconds(this.#now()), httpStatus: null, errorCode: null, fingerprint: this.#options.keyChecker.fingerprint(apiKey) }
  }

  async #reportIfDue(state: ReporterState, event: ReportEvent | null): Promise<ReporterResult> {
    const idle = { state, check: state.keyCheck, checks: state.keyChecks, event: null, sent: false }
    if (event === null || !this.#options.enabled) return idle
    if (state.lastFailureAt !== null) {
      const failed = Date.parse(state.lastFailureAt)
      if (!Number.isNaN(failed) && this.#now() - failed < FAILURE_BACKOFF_MS) return idle
    }
    return this.#send(state, event)
  }

  async #send(
    state: ReporterState,
    event: ReportEvent,
    extensions: Extension[] | null = null,
    languages: LanguageMapping[] | null = null,
  ): Promise<ReporterResult> {
    if (!this.#options.enabled) return { state, check: state.keyCheck, checks: state.keyChecks, event: null, sent: false }
    let ok = false
    try {
      const response = await this.#fetch(this.reportUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': `supertext-plugin-health/${PLUGIN_HEALTH_VERSION} (typescript) ${this.#options.plugin.name}/${this.#options.plugin.version}`,
        },
        body: JSON.stringify(this.buildReport(event, state, extensions, languages)),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      })
      ok = response.status >= 200 && response.status < 300
      await response.body?.cancel().catch(() => undefined)
    } catch {
      ok = false // never fails the caller: the center is optional
    }
    const next: ReporterState = ok
      ? {
          ...state,
          reportedVersions: this.versions,
          reportedKeyStatus: state.keyCheck?.status ?? state.reportedKeyStatus,
          reportedKeyStatuses: state.keyChecks
            ? Object.fromEntries(Object.entries(state.keyChecks).map(([name, check]) => [name, check.status]))
            : state.reportedKeyStatuses,
          lastFailureAt: null,
        }
      : { ...state, lastFailureAt: isoSeconds(this.#now()) }
    return { state: next, check: next.keyCheck, checks: next.keyChecks, event, sent: ok }
  }
}

/** `2026-10-13T08:00:00Z` for a time in milliseconds. */
export function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')
}

function checkBody(check: KeyCheck): Record<string, unknown> {
  const c: Record<string, unknown> = { status: check.status, checked_at: check.checkedAt }
  if (check.httpStatus !== null) c.http_status = check.httpStatus
  if (check.errorCode !== null) c.error_code = check.errorCode
  return c
}

function nameVersion(value: NameVersion): Record<string, string> {
  return value.version ? { name: value.name, version: value.version } : { name: value.name }
}

function detectRuntime(): NameVersion {
  const g = globalThis as { Deno?: { version?: { deno?: string } }; Bun?: { version?: string }; process?: { versions?: { node?: string } } }
  if (g.Deno?.version?.deno) return { name: 'Deno', version: g.Deno.version.deno }
  if (g.Bun?.version) return { name: 'Bun', version: g.Bun.version }
  return { name: 'Node.js', version: g.process?.versions?.node ?? null }
}

function processEnv(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
}
