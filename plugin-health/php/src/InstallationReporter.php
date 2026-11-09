<?php

declare(strict_types=1);

namespace Supertext\PluginHealth;

use Supertext\PluginHealth\Http\CurlTransport;
use Supertext\PluginHealth\Http\HttpRequest;
use Supertext\PluginHealth\Http\HttpTransport;

/**
 * Version reports to the Supertext Plugin Health dashboard, the API key check result and the ping endpoint
 * (../spec/reporter.json; protocol: the dashboard's docs/DEVELOPER.md → Report protocol).
 *
 * The reporter keeps no state of its own: the plugin loads its ReporterState, passes it in, and stores
 * the state it gets back (ReporterResult::$state). It never talks to Supertext itself: the plugin passes
 * a KeyChecker built on the bundled Supertext SDK. No method throws: the center is optional, and a failed
 * report is simply tried again an hour later.
 *
 * The key is never sent to the center, nor its fingerprint: only whether one is configured and how the
 * check went.
 */
final class InstallationReporter
{
    /**
     * The live Plugin Health dashboard, read from config.json next to this file (a copy of
     * plugin-health/config.json). SUPERTEXT_REPORT_URL overrides it. '' if the file is missing.
     */
    public static function defaultReportUrl(): string
    {
        if (self::$defaultReportUrl === null) {
            $json = @file_get_contents(__DIR__ . '/config.json');
            $config = \is_string($json) ? json_decode($json, true) : null;
            $url = \is_array($config) ? ($config['reportUrl'] ?? null) : null;
            self::$defaultReportUrl = \is_string($url) ? $url : '';
        }

        return self::$defaultReportUrl;
    }

    private static ?string $defaultReportUrl = null;

    /** Seconds a report may take. */
    public const REPORT_TIMEOUT = 3;

    /** Seconds without a new report after a failed one (except reportCheck()). */
    public const FAILURE_BACKOFF = 3600;

    public const EVENT_INSTALLED = 'installed';
    public const EVENT_SETTINGS_SAVED = 'settings_saved';
    public const EVENT_UPGRADED = 'upgraded';
    public const EVENT_API_KEY_CHECK = 'api_key_check';
    public const EVENT_CHECK = 'check';
    public const EVENT_EXTENSIONS = 'extensions';
    public const EVENT_LANGUAGES = 'languages';

    /** At most this many named keys are checked and reported; the rest are ignored. */
    public const MAX_API_KEYS = 20;

    /** At most this many installed plugins are sent; the rest are left out. */
    public const MAX_EXTENSIONS = 500;

    /** At most this many languages are sent; the rest are left out. */
    public const MAX_LANGUAGES = 100;

    private const CHALLENGE = '/^[A-Za-z0-9_-]{16,64}$/D';

    private const JSON = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;

    /** The URL reports are sent to. */
    public readonly string $reportUrl;

    private readonly string $runtimeName;
    private readonly ?string $runtimeVersion;

    /** @var callable(): float */
    private $now;

    /** @var (callable(): iterable<mixed>)|null */
    private $extensions;

    /** @var (callable(): iterable<mixed>)|null */
    private $languages;

    /**
     * @param bool                     $enabled        the "Send version information to Supertext" setting combined with the environment: see reportsEnabled()
     * @param string                   $siteUrl        base URL of the installation, as the system knows it
     * @param string                   $pluginName     the plugin's GitHub repository name, e.g. "Contao-Supertext-Translation"
     * @param string                   $pluginVersion  from the plugin's official version source
     * @param string                   $systemName     the CMS, PIM, shop or application, in its own spelling
     * @param KeyChecker               $keyChecker     the bundled SDK's key check: see KeyChecker and CallableKeyChecker
     * @param string|null              $systemVersion  its version, if known
     * @param string|null              $sdkVersion     the bundled Supertext SDK's version (its SDK_VERSION); null: no sdk_version in the report
     * @param string|null              $runtimeName    default "PHP"
     * @param string|null              $runtimeVersion default PHP_VERSION (when $runtimeName is null)
     * @param string|null              $callbackUrl    the plugin's public ping endpoint; null for hosted apps without one
     * @param string|null              $reportUrl      default SUPERTEXT_REPORT_URL from the environment, else defaultReportUrl() (config.json)
     * @param HttpTransport|null       $transport      HTTP for the report; default CurlTransport
     * @param (callable(): float)|null $now            wall-clock Unix time in seconds (for tests)
     * @param (callable(): iterable<mixed>)|null $extensions optional: returns the installed plugins (see sendExtensions()), so that
     *                                                     every report carries them; leave it out to send them only by hand (the default)
     * @param (callable(): iterable<mixed>)|null $languages  optional: returns the language mapping (see sendLanguages()), so that
     *                                                     every report carries it; leave it out to send it only by hand (the default)
     */
    public function __construct(
        private readonly bool $enabled,
        private readonly string $siteUrl,
        private readonly string $pluginName,
        private readonly string $pluginVersion,
        private readonly string $systemName,
        private readonly KeyChecker $keyChecker,
        private readonly ?string $systemVersion = null,
        private readonly ?string $sdkVersion = null,
        ?string $runtimeName = null,
        ?string $runtimeVersion = null,
        private readonly ?string $callbackUrl = null,
        ?string $reportUrl = null,
        private readonly ?HttpTransport $transport = null,
        ?callable $now = null,
        ?callable $extensions = null,
        ?callable $languages = null,
    ) {
        if ($runtimeName === null || $runtimeName === '') {
            $this->runtimeName = 'PHP';
            $this->runtimeVersion = $runtimeVersion ?? PHP_VERSION;
        } else {
            $this->runtimeName = $runtimeName;
            $this->runtimeVersion = $runtimeVersion;
        }
        $env = getenv('SUPERTEXT_REPORT_URL');
        $this->reportUrl = match (true) {
            $reportUrl !== null && trim($reportUrl) !== '' => trim($reportUrl),
            \is_string($env) && trim($env) !== '' => trim($env),
            default => self::defaultReportUrl(),
        };
        $this->now = $now ?? static fn (): float => microtime(true);
        $this->extensions = $extensions;
        $this->languages = $languages;
    }

    /**
     * The installed plugins as they are sent: names and versions trimmed (100 and 50 characters), types in
     * lower case (30), blank names and repeats (same type and name, ignoring case) dropped, at most MAX_EXTENSIONS.
     *
     * @param iterable<mixed> $extensions entries ['name' => 'Polylang Pro', 'version' => '3.7.2', 'active' => true, 'type' => 'plugin'];
     *                                    only the name is required
     *
     * @return list<array{name: string, version?: string, active?: bool, type?: string}>
     */
    public static function normalizeExtensions(iterable $extensions): array
    {
        $out = [];
        $seen = [];
        foreach ($extensions as $e) {
            if (\count($out) >= self::MAX_EXTENSIONS) {
                break;
            }
            if (!\is_array($e) || !\is_string($e['name'] ?? null)) {
                continue;
            }
            $name = self::cut(trim($e['name']), 100);
            if ($name === '') {
                continue;
            }
            $type = \is_string($e['type'] ?? null) ? self::cut(self::lower(trim($e['type'])), 30) : '';
            $id = $type . "\0" . self::lower($name);
            if (isset($seen[$id])) {
                continue;
            }
            $seen[$id] = true;
            $entry = ['name' => $name];
            $version = \is_string($e['version'] ?? null) ? self::cut(trim($e['version']), 50) : '';
            if ($version !== '') {
                $entry['version'] = $version;
            }
            if (\is_bool($e['active'] ?? null)) {
                $entry['active'] = $e['active'];
            }
            if ($type !== '') {
                $entry['type'] = $type;
            }
            $out[] = $entry;
        }

        return $out;
    }

    /**
     * The language mapping as it is sent: codes trimmed and cut to 35 characters, a blank Supertext code sent
     * as null, blank codes and repeats (same code, ignoring case) dropped, at most MAX_LANGUAGES.
     *
     * @param iterable<mixed> $languages entries ['code' => 'de_CH', 'supertext' => 'de-CH']; supertext null or
     *                                   left out: not mapped
     *
     * @return list<array{code: string, supertext: string|null}>
     */
    public static function normalizeLanguages(iterable $languages): array
    {
        $out = [];
        $seen = [];
        foreach ($languages as $l) {
            if (\count($out) >= self::MAX_LANGUAGES) {
                break;
            }
            if (!\is_array($l) || !\is_string($l['code'] ?? null)) {
                continue;
            }
            $code = self::cut(trim($l['code']), 35);
            $id = self::lower($code);
            if ($code === '' || isset($seen[$id])) {
                continue;
            }
            $seen[$id] = true;
            $supertext = \is_string($l['supertext'] ?? null) ? self::cut(trim($l['supertext']), 35) : '';
            $out[] = ['code' => $code, 'supertext' => $supertext === '' ? null : $supertext];
        }

        return $out;
    }

    private static function cut(string $value, int $length): string
    {
        return \function_exists('mb_substr') ? mb_substr($value, 0, $length, 'UTF-8') : substr($value, 0, $length);
    }

    private static function lower(string $value): string
    {
        return \function_exists('mb_strtolower') ? mb_strtolower($value, 'UTF-8') : strtolower($value);
    }

    /**
     * Whether version reports are on: SUPERTEXT_VERSION_REPORTS (0/false/off/no, 1/true/on/yes) wins over
     * the setting; the setting defaults to on.
     *
     * @param bool|null   $setting the plugin's setting; null when not set
     * @param string|null $env     the variable's value; when omitted, read from the environment
     */
    public static function reportsEnabled(?bool $setting = null, ?string $env = null): bool
    {
        if (\func_num_args() < 2) {
            $value = getenv('SUPERTEXT_VERSION_REPORTS');
            $env = \is_string($value) ? $value : null;
        }
        $value = strtolower(trim($env ?? ''));
        if (\in_array($value, ['0', 'false', 'off', 'no'], true)) {
            return false;
        }
        if (\in_array($value, ['1', 'true', 'on', 'yes'], true)) {
            return true;
        }

        return $setting ?? true;
    }

    /**
     * The answer of the plugin's public ping endpoint (`GET <callback>?challenge=<c>`): 200 with
     * {"ok":true,"plugin","challenge"} for a valid challenge, 400 otherwise, 404 while reporting is off.
     * Nothing a caller sends is echoed unless it matches the challenge pattern.
     *
     * @param string|null $challenge the `challenge` query parameter
     * @param string      $plugin    the plugin's GitHub repository name
     * @param bool        $enabled   reportsEnabled() (or the reporter's enabled())
     */
    public static function pingResponse(?string $challenge, string $plugin, bool $enabled): PingResponse
    {
        $headers = ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'];
        if (!$enabled) {
            return new PingResponse(404, $headers, '{"ok":false}');
        }
        if ($challenge === null || preg_match(self::CHALLENGE, $challenge) !== 1) {
            return new PingResponse(400, $headers, '{"ok":false}');
        }
        $body = json_encode(['ok' => true, 'plugin' => $plugin, 'challenge' => $challenge], self::JSON);

        return new PingResponse(200, $headers, $body === false ? '{"ok":false}' : $body);
    }

    /** Whether reports are sent (the ping endpoint answers only then). */
    public function enabled(): bool
    {
        return $this->enabled;
    }

    /** "<plugin>|<system>|<runtime>" versions (missing parts empty). */
    public function versions(): string
    {
        return implode('|', [$this->pluginVersion, $this->systemVersion ?? '', $this->runtimeVersion ?? '']);
    }

    /**
     * After the plugin's settings were saved: checks the key(s), reports `installed` or `settings_saved`.
     *
     * @param string|array<string, string> $apiKeys one key, or several by name in the order the settings show them
     */
    public function afterSettingsSaved(?ReporterState $state, #[\SensitiveParameter] string|array $apiKeys): ReporterResult
    {
        $current = $this->withChecks($state ?? ReporterState::empty(), $apiKeys, true);

        return $this->reportIfDue($current, $current->reportedVersions === null ? self::EVENT_INSTALLED : self::EVENT_SETTINGS_SAVED);
    }

    /**
     * On back-end requests that run the plugin's code: checks changed keys, reports what changed.
     *
     * @param string|array<string, string> $apiKeys
     */
    public function onRequest(?ReporterState $state, #[\SensitiveParameter] string|array $apiKeys): ReporterResult
    {
        $current = $this->withChecks($state ?? ReporterState::empty(), $apiKeys, false);

        return $this->reportIfDue($current, $this->dueEvent($current));
    }

    /**
     * A translation was rejected with 401/403: the key is invalid (no check against Supertext). With several
     * keys, $keyName says which one (the others keep their result; null: all).
     *
     * @param string|array<string, string> $apiKeys
     */
    public function authenticationFailed(?ReporterState $state, #[\SensitiveParameter] string|array $apiKeys, int $httpStatus = 401, ?string $keyName = null): ReporterResult
    {
        $base = $state ?? ReporterState::empty();
        if (\is_string($apiKeys)) {
            $current = new ReporterState(
                $base->reportedVersions,
                $base->keyChecks !== null ? null : $base->reportedKeyStatus,
                $base->lastFailureAt,
                $this->invalid($apiKeys, $httpStatus),
            );
        } else {
            $current = $this->withChecks($base, $apiKeys, false);
            $keyChecks = $current->keyChecks ?? [];
            foreach (self::namedKeys($apiKeys) as $name => $key) {
                if ($keyName === null || $name === trim($keyName)) {
                    $keyChecks[$name] = $this->invalid($key, $httpStatus);
                }
            }
            $current = new ReporterState($current->reportedVersions, $current->reportedKeyStatus, $current->lastFailureAt, null, $keyChecks, $current->reportedKeyStatuses);
        }

        return $this->reportIfDue($current, $this->dueEvent($current));
    }

    /**
     * The "Test connection" button: checks the key(s), reports a change.
     *
     * @param string|array<string, string> $apiKeys
     */
    public function testConnection(?ReporterState $state, #[\SensitiveParameter] string|array $apiKeys): ReporterResult
    {
        $current = $this->withChecks($state ?? ReporterState::empty(), $apiKeys, true);

        return $this->reportIfDue($current, $this->dueEvent($current));
    }

    /** Sends a `check` report now (commands, tests), even after a recent failure. */
    public function reportCheck(?ReporterState $state): ReporterResult
    {
        return $this->send($state ?? ReporterState::empty(), self::EVENT_CHECK);
    }

    /**
     * The plugin's "Send installed plugins to Supertext" button: sends event `extensions` with the list now,
     * even after a recent failure, but only while reporting is on (sent false otherwise).
     *
     * @param iterable<mixed> $extensions see normalizeExtensions()
     */
    public function sendExtensions(?ReporterState $state, iterable $extensions): ReporterResult
    {
        return $this->send($state ?? ReporterState::empty(), self::EVENT_EXTENSIONS, self::normalizeExtensions($extensions));
    }

    /**
     * The plugin's "Send language settings to Supertext" button: sends event `languages` with the mapping now,
     * even after a recent failure, but only while reporting is on (sent false otherwise).
     *
     * @param iterable<mixed> $languages see normalizeLanguages()
     */
    public function sendLanguages(?ReporterState $state, iterable $languages): ReporterResult
    {
        return $this->send($state ?? ReporterState::empty(), self::EVENT_LANGUAGES, null, self::normalizeLanguages($languages));
    }

    /**
     * The report body for an event and state.
     *
     * @param list<array{name: string, version?: string, active?: bool, type?: string}>|null $extensions the list to send;
     *                                                                                               default: the extensions function's, if any
     * @param list<array{code: string, supertext: string|null}>|null                         $languages  the mapping to send;
     *                                                                                               default: the languages function's, if any
     *
     * @return array<string, mixed>
     */
    public function buildReport(string $event, ReporterState $state, ?array $extensions = null, ?array $languages = null): array
    {
        $body = [
            'schema' => 1,
            'event' => $event,
            'site_url' => $this->siteUrl,
            'plugin' => ['name' => $this->pluginName, 'version' => $this->pluginVersion],
            'system' => self::nameVersion($this->systemName, $this->systemVersion),
            'runtime' => self::nameVersion($this->runtimeName, $this->runtimeVersion),
        ];
        if ($this->sdkVersion !== null && $this->sdkVersion !== '') {
            $body['sdk_version'] = $this->sdkVersion;
        }
        if ($state->keyChecks !== null) {
            $keys = [];
            foreach ($state->keyChecks as $name => $check) {
                $keys[] = ['name' => (string) $name, 'configured' => $check->fingerprint !== '', 'check' => self::checkBody($check)];
            }
            $body['api_keys'] = $keys;
        } elseif ($state->keyCheck !== null) {
            $body['api_key_configured'] = $state->keyCheck->fingerprint !== '';
            $body['api_key_check'] = self::checkBody($state->keyCheck);
        }
        if ($this->callbackUrl !== null && $this->callbackUrl !== '') {
            $body['callback'] = ['url' => $this->callbackUrl];
        }
        $list = $extensions ?? $this->configuredExtensions();
        if ($list !== null) {
            $body['extensions'] = $list;
        }
        $mapping = $languages ?? $this->configuredLanguages();
        if ($mapping !== null) {
            $body['languages'] = $mapping;
        }

        return $body;
    }

    /** @return list<array{code: string, supertext: string|null}>|null */
    private function configuredLanguages(): ?array
    {
        if ($this->languages === null) {
            return null;
        }
        try {
            return self::normalizeLanguages(($this->languages)());
        } catch (\Throwable) {
            return null; // never fails the report: the mapping is extra information
        }
    }

    /** @return list<array{name: string, version?: string, active?: bool, type?: string}>|null */
    private function configuredExtensions(): ?array
    {
        if ($this->extensions === null) {
            return null;
        }
        try {
            return self::normalizeExtensions(($this->extensions)());
        } catch (\Throwable) {
            return null; // never fails the report: the list is extra information
        }
    }

    private function dueEvent(ReporterState $state): ?string
    {
        if ($state->reportedVersions === null) {
            return self::EVENT_INSTALLED;
        }
        if ($state->reportedVersions !== $this->versions()) {
            return self::EVENT_UPGRADED;
        }
        if ($state->keyChecks !== null) {
            $reported = $state->reportedKeyStatuses ?? [];
            if (\count($reported) !== \count($state->keyChecks)) {
                return self::EVENT_API_KEY_CHECK;
            }
            foreach ($state->keyChecks as $name => $check) {
                if (($reported[$name] ?? null) !== $check->status) {
                    return self::EVENT_API_KEY_CHECK;
                }
            }

            return null;
        }
        if ($state->keyCheck !== null && $state->keyCheck->status !== $state->reportedKeyStatus) {
            return self::EVENT_API_KEY_CHECK;
        }

        return null;
    }

    /**
     * The state with fresh checks: always ($force), else only for keys that are new or changed.
     *
     * @param string|array<string, string> $apiKeys
     */
    private function withChecks(ReporterState $state, #[\SensitiveParameter] string|array $apiKeys, bool $force): ReporterState
    {
        if (\is_string($apiKeys)) {
            if (!$force && $state->keyChecks === null && $state->keyCheck !== null && $state->keyCheck->fingerprint === $this->fingerprint($apiKeys)) {
                return $state;
            }

            // Coming from several keys: report the single key even if its status is the one reported before.
            return new ReporterState($state->reportedVersions, $state->keyChecks !== null ? null : $state->reportedKeyStatus, $state->lastFailureAt, $this->check($apiKeys));
        }
        $keyChecks = [];
        foreach (self::namedKeys($apiKeys) as $name => $key) {
            $old = $state->keyChecks[$name] ?? null;
            $keyChecks[$name] = !$force && $old !== null && $old->fingerprint === $this->fingerprint($key) ? $old : $this->check($key);
        }

        return new ReporterState($state->reportedVersions, $state->reportedKeyStatus, $state->lastFailureAt, null, $keyChecks, $state->reportedKeyStatuses);
    }

    /**
     * The named keys (at most MAX_API_KEYS, names trimmed, blank and repeated names dropped).
     *
     * @param array<array-key, mixed> $apiKeys
     *
     * @return array<string, string>
     */
    private static function namedKeys(#[\SensitiveParameter] array $apiKeys): array
    {
        $out = [];
        foreach ($apiKeys as $raw => $key) {
            $name = mb_substr(trim((string) $raw), 0, 60);
            if ($name === '' || \array_key_exists($name, $out)) {
                continue;
            }
            $out[$name] = \is_string($key) ? $key : '';
            if (\count($out) >= self::MAX_API_KEYS) {
                break;
            }
        }

        return $out;
    }

    private function invalid(#[\SensitiveParameter] string $apiKey, int $httpStatus): KeyCheck
    {
        return new KeyCheck(KeyCheck::INVALID, $this->timestamp(), $httpStatus, null, $this->fingerprint($apiKey));
    }

    /** @return array{status: string, checked_at: string, http_status?: int, error_code?: string} */
    private static function checkBody(KeyCheck $check): array
    {
        $c = ['status' => $check->status, 'checked_at' => $check->checkedAt];
        if ($check->httpStatus !== null) {
            $c['http_status'] = $check->httpStatus;
        }
        if ($check->errorCode !== null) {
            $c['error_code'] = $check->errorCode;
        }

        return $c;
    }

    private function check(#[\SensitiveParameter] string $apiKey): KeyCheck
    {
        try {
            $check = KeyCheck::from($this->keyChecker->check($apiKey));
            if ($check !== null) {
                return $check;
            }
        } catch (\Throwable) {
            // The SDK's check never throws; a plugin's own checker might.
        }

        return new KeyCheck(KeyCheck::ERROR, $this->timestamp(), null, null, $this->fingerprint($apiKey));
    }

    private function fingerprint(#[\SensitiveParameter] string $apiKey): string
    {
        try {
            return $this->keyChecker->fingerprint($apiKey);
        } catch (\Throwable) {
            return '';
        }
    }

    private function reportIfDue(ReporterState $state, ?string $event): ReporterResult
    {
        if ($event === null || !$this->enabled) {
            return new ReporterResult($state, $state->keyCheck, null, false, $state->keyChecks);
        }
        if ($state->lastFailureAt !== null) {
            $failed = strtotime($state->lastFailureAt);
            if ($failed !== false && ($this->now)() - $failed < self::FAILURE_BACKOFF) {
                return new ReporterResult($state, $state->keyCheck, null, false, $state->keyChecks);
            }
        }

        return $this->send($state, $event);
    }

    /**
     * @param list<array{name: string, version?: string, active?: bool, type?: string}>|null $extensions
     * @param list<array{code: string, supertext: string|null}>|null                         $languages
     */
    private function send(ReporterState $state, string $event, ?array $extensions = null, ?array $languages = null): ReporterResult
    {
        if (!$this->enabled) {
            return new ReporterResult($state, $state->keyCheck, null, false, $state->keyChecks);
        }
        $ok = false;
        try {
            $transport = $this->transport ?? new CurlTransport();
            $body = json_encode($this->buildReport($event, $state, $extensions, $languages), self::JSON | JSON_THROW_ON_ERROR);
            $response = $transport->send(new HttpRequest('POST', $this->reportUrl, [
                'Content-Type' => 'application/json',
                'Accept' => 'application/json',
                'User-Agent' => 'supertext-plugin-health/' . PluginHealth::PLUGIN_HEALTH_VERSION . ' (php) ' . $this->pluginName . '/' . $this->pluginVersion,
            ], $body, (float) self::REPORT_TIMEOUT));
            $ok = $response->status >= 200 && $response->status < 300;
        } catch (\Throwable) {
            // Never fails the caller: the center is optional (also: no ext-curl and no transport).
            $ok = false;
        }
        $next = $ok
            ? new ReporterState(
                $this->versions(),
                $state->keyCheck->status ?? $state->reportedKeyStatus,
                null,
                $state->keyCheck,
                $state->keyChecks,
                $state->keyChecks === null ? $state->reportedKeyStatuses : array_map(static fn (KeyCheck $c): string => $c->status, $state->keyChecks),
            )
            : new ReporterState($state->reportedVersions, $state->reportedKeyStatus, $this->timestamp(), $state->keyCheck, $state->keyChecks, $state->reportedKeyStatuses);

        return new ReporterResult($next, $next->keyCheck, $event, $ok, $next->keyChecks);
    }

    private function timestamp(): string
    {
        return KeyCheck::timestamp(($this->now)());
    }

    /** @return array{name: string, version?: string} */
    private static function nameVersion(string $name, ?string $version): array
    {
        return $version !== null && $version !== '' ? ['name' => $name, 'version' => $version] : ['name' => $name];
    }
}
