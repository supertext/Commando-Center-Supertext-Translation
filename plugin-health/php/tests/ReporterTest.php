<?php

declare(strict_types=1);

namespace Supertext\PluginHealth\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Supertext\PluginHealth\CallableKeyChecker;
use Supertext\PluginHealth\Http\HttpRequest;
use Supertext\PluginHealth\Http\HttpResponse;
use Supertext\PluginHealth\InstallationReporter;
use Supertext\PluginHealth\KeyCheck;
use Supertext\PluginHealth\KeyChecker;
use Supertext\PluginHealth\PluginHealth;
use Supertext\PluginHealth\ReporterState;

/**
 * ../spec/reporter.json and the dashboard's spec (spec/callback-vectors.json, spec/report-v1.schema.json).
 * That the center accepts every report body is checked in the center's own tests (with the TypeScript reference).
 */
final class ReporterTest extends TestCase
{
    private const REPORT_URL = 'https://center.test/api/v1/report';

    /** @return array<string, mixed> */
    private static function json(string $path): array
    {
        $json = file_get_contents(__DIR__ . '/' . $path);
        self::assertIsString($json, $path);
        $data = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($data);

        return self::map($data);
    }

    /** @return array<string, mixed> ../spec/reporter.json */
    private static function spec(): array
    {
        return self::json('../../spec/reporter.json');
    }

    /** @return array<string, mixed> the center's spec/<name> */
    private static function center(string $name): array
    {
        return self::json('../../../spec/' . $name);
    }

    /** @return array<string, mixed> */
    private static function map(mixed $value): array
    {
        self::assertIsArray($value);
        /** @var array<string, mixed> $value */
        return $value;
    }

    /** @return list<array<string, mixed>> */
    private static function maps(mixed $value): array
    {
        self::assertIsArray($value);
        self::assertTrue(array_is_list($value));

        return array_map(self::map(...), $value);
    }

    private static function str(mixed $value): string
    {
        self::assertIsString($value);

        return $value;
    }

    private static function strOrNull(mixed $value): ?string
    {
        return $value === null ? null : self::str($value);
    }

    private static function time(string $iso): float
    {
        $time = strtotime($iso);
        self::assertIsInt($time);

        return (float) $time;
    }

    /** @return array<string, string> */
    private static function fingerprints(): array
    {
        /** @var array<string, string> */
        return self::map(self::spec()['fingerprints']);
    }

    /**
     * A reporter for a spec config (../spec/reporter.json → config, with a scenario's overrides).
     *
     * @param array<string, mixed> $config
     */
    private static function reporter(array $config, KeyChecker $keyChecker, ?Fakes $center = null, ?float $now = null): InstallationReporter
    {
        $plugin = self::map($config['plugin']);
        $system = self::map($config['system']);
        $runtime = isset($config['runtime']) ? self::map($config['runtime']) : [];
        self::assertIsBool($config['enabled']);

        return new InstallationReporter(
            enabled: $config['enabled'],
            siteUrl: self::str($config['siteUrl']),
            pluginName: self::str($plugin['name']),
            pluginVersion: self::str($plugin['version']),
            systemName: self::str($system['name']),
            keyChecker: $keyChecker,
            systemVersion: self::strOrNull($system['version'] ?? null),
            sdkVersion: self::strOrNull($config['sdkVersion'] ?? null),
            runtimeName: self::strOrNull($runtime['name'] ?? null),
            runtimeVersion: self::strOrNull($runtime['version'] ?? null),
            callbackUrl: self::strOrNull($config['callbackUrl'] ?? null),
            reportUrl: self::REPORT_URL,
            transport: $center,
            now: $now === null ? null : static fn (): float => $now,
            extensions: isset($config['extensions']) && \is_array($config['extensions']) ? static fn (): array => (array) $config['extensions'] : null,
        );
    }

    /** @return array<string, mixed> */
    private static function config(): array
    {
        return self::map(self::spec()['config']);
    }

    // ---- ../spec/reporter.json ----

    public function testDefaults(): void
    {
        $defaults = self::map(self::spec()['defaults']);
        self::assertSame($defaults['reportUrl'], InstallationReporter::defaultReportUrl());
        self::assertSame($defaults['reportTimeoutSeconds'], InstallationReporter::REPORT_TIMEOUT);
        self::assertSame($defaults['failureBackoffSeconds'], InstallationReporter::FAILURE_BACKOFF);
    }

    public function testVersionIsTheSameInAllLanguages(): void
    {
        self::assertSame(self::json('../../typescript/package.json')['version'], PluginHealth::PLUGIN_HEALTH_VERSION);
    }

    /** @return array<string, array{array<string, mixed>}> */
    public static function enabledCases(): array
    {
        $out = [];
        foreach (self::maps(self::spec()['enabled']) as $i => $case) {
            $out['#' . $i . ' ' . json_encode($case)] = [$case];
        }

        return $out;
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('enabledCases')]
    public function testEnabled(array $case): void
    {
        self::assertTrue($case['setting'] === null || \is_bool($case['setting']));
        self::assertSame($case['out'], InstallationReporter::reportsEnabled($case['setting'], self::strOrNull($case['env'])));
    }

    public function testEnabledReadsTheEnvironment(): void
    {
        putenv('SUPERTEXT_VERSION_REPORTS=off');
        try {
            self::assertFalse(InstallationReporter::reportsEnabled(true));
            self::assertTrue(InstallationReporter::reportsEnabled(true, null));
        } finally {
            putenv('SUPERTEXT_VERSION_REPORTS');
        }
        self::assertTrue(InstallationReporter::reportsEnabled());
        self::assertFalse(InstallationReporter::reportsEnabled(false));
    }

    /** @return array<string, array{array<string, mixed>, string}> */
    public static function pingCases(): array
    {
        $ping = self::map(self::spec()['ping']);
        $out = [];
        foreach (self::maps($ping['cases']) as $i => $case) {
            $out['#' . $i . ' ' . json_encode($case)] = [$case, self::str($ping['plugin'])];
        }

        return $out;
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('pingCases')]
    public function testPing(array $case, string $plugin): void
    {
        self::assertIsBool($case['enabled']);
        $response = InstallationReporter::pingResponse(self::strOrNull($case['challenge']), $plugin, $case['enabled']);
        self::assertSame($case['status'], $response->status);
        self::assertSame($case['body'], json_decode($response->body, true, 512, JSON_THROW_ON_ERROR));
        self::assertSame(['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'], $response->headers);
    }

    /** @return array<string, array{array<string, mixed>}> */
    public static function scenarios(): array
    {
        $out = [];
        foreach (self::maps(self::spec()['scenarios']) as $scenario) {
            $scenario['config'] = array_replace(self::config(), self::map($scenario['config'] ?? []));
            $out[self::str($scenario['name'])] = [$scenario];
        }

        return $out;
    }

    /** @param array<string, mixed> $scenario */
    #[DataProvider('scenarios')]
    public function testScenario(array $scenario): void
    {
        $config = self::map($scenario['config']);
        $plugin = self::map($config['plugin']);
        $state = ReporterState::fromJson(json_encode($scenario['state'], JSON_THROW_ON_ERROR));
        self::assertSame($scenario['state'], $state->toArray());
        foreach (self::maps($scenario['steps']) as $i => $step) {
            $action = self::str($step['action']);
            $label = '#' . $i . ' ' . $action;
            /** @var string|array<string, string> $apiKey */
            $apiKey = isset($step['apiKeys']) ? self::map($step['apiKeys']) : self::str($step['apiKey']);
            $fakes = new Fakes(
                isset($step['keyChecks']) ? (array) $step['keyChecks'] : (isset($step['keyCheck']) ? self::map($step['keyCheck']) : null),
                isset($step['report']) ? self::map($step['report']) : null,
                self::fingerprints(),
            );
            $reporter = self::reporter($config, $fakes, $fakes, self::time(self::str($step['now'])));
            $result = match ($action) {
                'afterSettingsSaved' => $reporter->afterSettingsSaved($state, $apiKey),
                'onRequest' => $reporter->onRequest($state, $apiKey),
                'authenticationFailed' => $reporter->authenticationFailed($state, $apiKey, \is_int($step['httpStatus']) ? $step['httpStatus'] : 401, isset($step['keyName']) ? self::str($step['keyName']) : null),
                'testConnection' => $reporter->testConnection($state, $apiKey),
                'reportCheck' => $reporter->reportCheck($state),
                'sendExtensions' => $reporter->sendExtensions($state, \is_array($step['extensions']) ? $step['extensions'] : []),
                default => self::fail('unknown action ' . $action),
            };
            $expect = self::map($step['expect']);
            self::assertSame([], $fakes->errors, $label);
            self::assertSame($expect['calls'], $fakes->calls, $label);
            self::assertSame($expect['event'], $result->event, $label);
            self::assertSame($expect['sent'], $result->sent, $label);
            self::assertSame($expect['check'], $result->check?->toArray(), $label);
            self::assertSame($expect['checks'], $result->checks === null ? null : array_map(static fn ($c) => $c->toArray(), $result->checks), $label);
            self::assertSame($expect['state'], $result->state->toArray(), $label);
            foreach ($fakes->reports as $report) {
                self::assertSame(self::REPORT_URL, $report->url, $label);
                self::assertSame('POST', $report->method, $label);
                self::assertSame((float) InstallationReporter::REPORT_TIMEOUT, $report->timeout, $label);
                self::assertSame('application/json', $report->headers['Content-Type'], $label);
                self::assertSame(
                    'supertext-plugin-health/' . PluginHealth::PLUGIN_HEALTH_VERSION . ' (php) ' . self::str($plugin['name']) . '/' . self::str($plugin['version']),
                    $report->headers['User-Agent'],
                    $label,
                );
            }
            if (isset($expect['reportBody'])) {
                self::assertCount(1, $fakes->reports, $label);
                self::assertEquals($expect['reportBody'], json_decode((string) $fakes->reports[0]->body, true, 512, JSON_THROW_ON_ERROR), $label);
            }
            // The stored form survives a JSON round trip, in the same shape.
            $json = $result->state->toJson();
            self::assertSame($expect['state'], json_decode($json, true, 512, JSON_THROW_ON_ERROR), $label);
            self::assertSame($json, json_encode($result->state, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), $label);
            $state = ReporterState::fromJson($json);
            self::assertSame($expect['state'], $state->toArray(), $label);
        }
    }

    // ---- the center's spec ----

    /** @return array<string, array{array<string, mixed>}> */
    public static function endpointCases(): array
    {
        $out = [];
        foreach (self::maps(self::map(self::center('callback-vectors.json')['endpoint'])['cases']) as $i => $case) {
            $out['#' . $i . ' ' . json_encode($case['challenge'])] = [$case];
        }

        return $out;
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('endpointCases')]
    public function testPingEndpoint(array $case): void
    {
        $response = InstallationReporter::pingResponse(self::strOrNull($case['challenge']), 'Some-Supertext-Translation', true);
        self::assertSame($case['status'], $response->status);
        $expected = self::map($case['body']);
        if (isset($expected['plugin'])) {
            $expected['plugin'] = 'Some-Supertext-Translation';
        }
        self::assertSame($expected, json_decode($response->body, true, 512, JSON_THROW_ON_ERROR));
        self::assertSame(['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'], $response->headers);
    }

    public function testReportsHaveTheFieldsOfTheCenterSchema(): void
    {
        $schema = self::center('report-v1.schema.json');
        $properties = self::map($schema['properties']);
        $required = $schema['required'];
        self::assertIsArray($required);
        $reporter = self::reporter(self::config(), new Fakes(null, null, []));
        $check = new KeyCheck(KeyCheck::INVALID, '2026-10-13T08:00:00Z', 401, 'INVALID_API_KEY', 'abc');
        foreach ([ReporterState::empty(), new ReporterState(keyCheck: $check)] as $state) {
            $body = $reporter->buildReport(InstallationReporter::EVENT_SETTINGS_SAVED, $state);
            foreach ($required as $field) {
                self::assertIsString($field);
                self::assertArrayHasKey($field, $body);
            }
            foreach (array_keys($body) as $field) {
                self::assertArrayHasKey($field, $properties);
            }
        }
    }

    // ---- reporter ----

    public function testNeverSendsTheKeyNorTheFingerprint(): void
    {
        $check = ['status' => 'ok', 'checkedAt' => '2026-10-13T08:00:00Z', 'httpStatus' => 200, 'errorCode' => null, 'fingerprint' => 'fp-abc'];
        $fakes = new Fakes($check, ['status' => 202], ['secret-key-123' => 'fp-abc']);
        $result = self::reporter(self::config(), $fakes, $fakes)->afterSettingsSaved(null, 'secret-key-123');
        self::assertSame(['keyCheck', 'report'], $fakes->calls);
        self::assertTrue($result->sent);
        $sent = (string) $fakes->reports[0]->body . json_encode($fakes->reports[0]->headers) . $fakes->reports[0]->url;
        self::assertStringNotContainsString('secret-key-123', $sent);
        self::assertStringNotContainsString('fp-abc', $sent);
        self::assertStringNotContainsString('secret-key-123', $result->state->toJson());
        self::assertStringNotContainsString('secret-key-123', print_r($result, true));
    }

    public function testACheckerThatThrowsGivesAnErrorCheck(): void
    {
        $checker = new CallableKeyChecker(
            static function (string $key): never {
                throw new \RuntimeException('boom');
            },
            static fn (string $key): string => 'fp',
        );
        $reporter = self::reporter(['enabled' => false] + self::config(), $checker, null, self::time('2026-10-13T08:00:00Z') + 0.7);
        $result = $reporter->afterSettingsSaved(null, 'k');
        self::assertSame(['status' => 'error', 'checkedAt' => '2026-10-13T08:00:00Z', 'httpStatus' => null, 'errorCode' => null, 'fingerprint' => 'fp'], $result->check?->toArray());
        self::assertNull($result->event);
        self::assertSame($result->check, $result->state->keyCheck);
    }

    public function testACheckerThatReturnsGarbageGivesAnErrorCheck(): void
    {
        foreach (['nope', 42, null, ['status' => 'ok'], new \stdClass()] as $garbage) {
            $checker = new CallableKeyChecker(static fn (string $key): mixed => $garbage, static fn (string $key): string => 'fp');
            $result = self::reporter(['enabled' => false] + self::config(), $checker, null, self::time('2026-10-13T08:00:00Z'))->testConnection(null, 'k');
            self::assertSame('error', $result->check?->status, get_debug_type($garbage));
            self::assertSame('fp', $result->check->fingerprint);
        }
        // A fingerprint that fails too: still no exception.
        $checker = new CallableKeyChecker(static fn (string $key): mixed => null, static fn (string $key): mixed => 5);
        $result = self::reporter(['enabled' => false] + self::config(), $checker)->onRequest(null, 'k');
        self::assertSame('error', $result->check?->status);
        self::assertSame('', $result->check->fingerprint);
    }

    public function testTheReporterNeverThrows(): void
    {
        $center = new class () implements \Supertext\PluginHealth\Http\HttpTransport {
            public function send(HttpRequest $request): HttpResponse
            {
                throw new \Error('boom');
            }
        };
        $checker = new CallableKeyChecker(static fn (string $key): array => ['status' => 'ok', 'checkedAt' => '2026-10-13T08:00:00Z', 'fingerprint' => 'fp'], static fn (string $key): string => 'fp');
        $reporter = new InstallationReporter(true, 'https://x.test', 'P', '1', 'S', $checker, reportUrl: self::REPORT_URL, transport: $center, now: static fn (): float => self::time('2026-10-13T08:00:00Z'));
        $result = $reporter->afterSettingsSaved(null, 'k1');
        self::assertFalse($result->sent);
        self::assertSame(InstallationReporter::EVENT_INSTALLED, $result->event);
        self::assertSame('2026-10-13T08:00:00Z', $result->state->lastFailureAt);
        self::assertFalse($reporter->reportCheck($result->state)->sent);
    }

    public function testCallableKeyCheckerTakesTheSdkFunctions(): void
    {
        $checker = CallableKeyChecker::fromCallables(
            static fn (string $key): SdkLike => new SdkLike('invalid', '2026-10-13T08:00:00Z', 401, 'INVALID_API_KEY', SdkLike::apiKeyFingerprint($key)),
            [SdkLike::class, 'apiKeyFingerprint'],
        );
        self::assertSame(self::fingerprints()['k1'], $checker->fingerprint('Supertext-Auth-Key k1'));
        self::assertSame(self::fingerprints()['k2'], $checker->fingerprint('k2'));
        self::assertSame('', $checker->fingerprint('  '));
        $fakes = new Fakes(null, ['status' => 202], []);
        $result = self::reporter(self::config(), $checker, $fakes, self::time('2026-10-13T08:00:00Z'))->afterSettingsSaved(null, 'k1');
        self::assertSame([
            'status' => 'invalid',
            'checkedAt' => '2026-10-13T08:00:00Z',
            'httpStatus' => 401,
            'errorCode' => 'INVALID_API_KEY',
            'fingerprint' => self::fingerprints()['k1'],
        ], $result->check?->toArray());
        self::assertTrue($result->sent);
        self::assertSame('invalid', $result->state->reportedKeyStatus);
    }

    public function testKeyCheckFrom(): void
    {
        $expected = ['status' => 'ok', 'checkedAt' => '2026-10-13T08:00:00Z', 'httpStatus' => 200, 'errorCode' => null, 'fingerprint' => 'abc'];
        $check = new KeyCheck('ok', '2026-10-13T08:00:00Z', 200, null, 'abc');
        self::assertSame($check, KeyCheck::from($check));
        // The SDK's ApiKeyCheck, under whatever namespace: public properties only.
        self::assertSame($expected, KeyCheck::from(new SdkLike('ok', '2026-10-13T08:00:00Z', 200, null, 'abc'))?->toArray());
        self::assertSame($expected, KeyCheck::from((object) ($expected + ['extra' => 1]))?->toArray());
        self::assertSame($expected, KeyCheck::from($expected + ['extra' => 1])?->toArray());
        self::assertSame($expected, KeyCheck::from(['httpStatus' => 200.0] + $expected)?->toArray());
        self::assertSame(
            ['status' => 'unreachable', 'checkedAt' => 'x', 'httpStatus' => null, 'errorCode' => null, 'fingerprint' => ''],
            KeyCheck::from(['status' => 'unreachable', 'checkedAt' => 'x', 'httpStatus' => '500', 'errorCode' => 7, 'fingerprint' => null])?->toArray(),
        );
        foreach ([null, 'ok', 42, [], ['status' => 'ok'], ['checkedAt' => 'x'], ['status' => 1, 'checkedAt' => 'x'], new \stdClass(), new \ArrayObject($expected)] as $garbage) {
            self::assertNull(KeyCheck::from($garbage), get_debug_type($garbage));
        }
        self::assertSame('2026-10-13T08:00:00Z', KeyCheck::timestamp(self::time('2026-10-13T08:00:00Z') + 0.999));
    }

    public function testWithoutAnSdkVersionTheReportHasNoSdkVersion(): void
    {
        $config = self::config();
        $config['sdkVersion'] = null;
        $body = self::reporter($config, new Fakes(null, null, []))->buildReport(InstallationReporter::EVENT_CHECK, ReporterState::empty());
        self::assertArrayNotHasKey('sdk_version', $body);
        $body = self::reporter(self::config(), new Fakes(null, null, []))->buildReport(InstallationReporter::EVENT_CHECK, ReporterState::empty());
        self::assertSame('0.3.0', $body['sdk_version']);
    }

    public function testReadsAStateStoredByTheSdkReporter(): void
    {
        // As stored by the Supertext SDK 0.1–0.2 (PHP: json_encode($state) of Supertext\Sdk\V1\ReporterState).
        $old = '{"reportedVersions":"0.2.0|12.0.0|8.3.6","reportedKeyStatus":"invalid","lastFailureAt":"2026-10-13T08:00:00Z","keyCheck":{"status":"invalid","checkedAt":"2026-10-13T07:59:58Z","httpStatus":401,"errorCode":"INVALID_API_KEY","fingerprint":"6ab9f1eb8f7d3388f4f9d586f66e99fd54080df2c446f0e58668b09c08a16dd0"}}';
        $state = ReporterState::fromJson($old);
        self::assertSame('0.2.0|12.0.0|8.3.6', $state->reportedVersions);
        self::assertSame('invalid', $state->reportedKeyStatus);
        self::assertSame('2026-10-13T08:00:00Z', $state->lastFailureAt);
        self::assertEquals(new KeyCheck('invalid', '2026-10-13T07:59:58Z', 401, 'INVALID_API_KEY', '6ab9f1eb8f7d3388f4f9d586f66e99fd54080df2c446f0e58668b09c08a16dd0'), $state->keyCheck);
        self::assertSame(substr($old, 0, -1) . ',"keyChecks":null,"reportedKeyStatuses":null}', $state->toJson());
        self::assertEquals($state, ReporterState::from($old));
        self::assertEquals($state, ReporterState::from(json_decode($old)));
        self::assertEquals($state, ReporterState::fromArray(json_decode($old, true)));
        self::assertSame($state, ReporterState::from($state));
    }

    public function testABrokenStoredStateIsEmpty(): void
    {
        $empty = ['reportedVersions' => null, 'reportedKeyStatus' => null, 'lastFailureAt' => null, 'keyCheck' => null, 'keyChecks' => null, 'reportedKeyStatuses' => null];
        self::assertSame($empty, ReporterState::fromJson('not json')->toArray());
        self::assertSame($empty, ReporterState::fromJson('')->toArray());
        self::assertSame($empty, ReporterState::fromJson(null)->toArray());
        self::assertSame($empty, ReporterState::fromJson('"a string"')->toArray());
        self::assertSame($empty, ReporterState::from(null)->toArray());
        self::assertSame($empty, ReporterState::from(42)->toArray());
        self::assertSame($empty, ReporterState::fromArray(['reportedVersions' => 5, 'keyCheck' => ['status' => 'ok']])->toArray());
        self::assertSame($empty, ReporterState::fromArray(['keyCheck' => 'nope'])->toArray());
        self::assertSame($empty, ReporterState::empty()->toArray());
    }

    public function testDefaultRuntimeIsPhp(): void
    {
        $config = self::config();
        unset($config['runtime']);
        $reporter = self::reporter($config, new Fakes(null, null, []));
        $body = $reporter->buildReport(InstallationReporter::EVENT_CHECK, ReporterState::empty());
        self::assertSame(['name' => 'PHP', 'version' => PHP_VERSION], $body['runtime']);
        self::assertSame('0.2.0|12.0.0|' . PHP_VERSION, $reporter->versions());
        self::assertTrue($reporter->enabled());
    }

    public function testMissingVersionsAreLeftOut(): void
    {
        $checker = new Fakes(null, null, []);
        $reporter = new InstallationReporter(false, 'https://x.test', 'P', '1', 'S', $checker, runtimeName: 'FrankenPHP');
        $body = $reporter->buildReport(InstallationReporter::EVENT_CHECK, ReporterState::empty());
        self::assertSame(['name' => 'S'], $body['system']);
        self::assertSame(['name' => 'FrankenPHP'], $body['runtime']);
        self::assertArrayNotHasKey('callback', $body);
        self::assertArrayNotHasKey('api_key_check', $body);
        self::assertSame('1||', $reporter->versions());
        self::assertFalse($reporter->enabled());
        self::assertSame([], $checker->calls);
    }

    public function testReportUrlFromTheEnvironment(): void
    {
        $args = ['enabled' => true, 'siteUrl' => 'https://x.test', 'pluginName' => 'P', 'pluginVersion' => '1', 'systemName' => 'S', 'keyChecker' => new Fakes(null, null, [])];
        self::assertSame(InstallationReporter::defaultReportUrl(), (new InstallationReporter(...$args))->reportUrl);
        putenv('SUPERTEXT_REPORT_URL=https://env.test/report');
        try {
            self::assertSame('https://env.test/report', (new InstallationReporter(...$args))->reportUrl);
            self::assertSame('https://own.test/report', (new InstallationReporter(...$args, reportUrl: 'https://own.test/report'))->reportUrl);
        } finally {
            putenv('SUPERTEXT_REPORT_URL');
        }
    }

    public function testAtMostFiveHundredExtensionsAndCutLongNames(): void
    {
        $list = [['name' => str_repeat('x', 150), 'version' => str_repeat('v', 80), 'type' => str_repeat('P', 40)]];
        for ($n = 0; $n < 520; ++$n) {
            $list[] = ['name' => 'Plugin ' . $n, 'version' => '1.0'];
        }
        $out = InstallationReporter::normalizeExtensions($list);
        self::assertCount(500, $out);
        self::assertSame(['name' => str_repeat('x', 100), 'version' => str_repeat('v', 50), 'type' => str_repeat('p', 30)], $out[0]);
        self::assertSame([['name' => 'Über', 'type' => 'thème']], InstallationReporter::normalizeExtensions([['name' => 'Über', 'type' => 'THÈME'], 'junk', ['name' => 'über', 'type' => 'thème']]));
    }

    public function testAThrowingExtensionsFunctionLeavesTheListOut(): void
    {
        $fakes = new Fakes(null, ['status' => 202], self::fingerprints());
        $reporter = new InstallationReporter(
            enabled: true,
            siteUrl: 'https://cms.example.ch',
            pluginName: 'X',
            pluginVersion: '1.0.0',
            systemName: 'Y',
            keyChecker: $fakes,
            reportUrl: self::REPORT_URL,
            transport: $fakes,
            extensions: static fn (): array => throw new \RuntimeException('boom'),
        );
        self::assertTrue($reporter->reportCheck(null)->sent);
        $body = json_decode((string) $fakes->reports[0]->body, true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($body);
        self::assertArrayNotHasKey('extensions', $body);
    }

    public function testAtMostTwentyNamedKeys(): void
    {
        $checks = array_fill(0, 30, ['status' => 'ok', 'checkedAt' => '2026-10-13T08:00:00Z', 'httpStatus' => 200, 'errorCode' => null, 'fingerprint' => 'fp']);
        $fakes = new Fakes($checks, ['status' => 202], []);
        $config = self::config();
        $reporter = self::reporter($config, new CallableKeyChecker(static fn (): array => $checks[0], static fn (): string => 'fp'), $fakes, 1760342400.0);
        $keys = [' ' => 'x', 'A ' => 'k1'];
        for ($n = 0; $n < 25; ++$n) {
            $keys['Key ' . $n] = 'k1';
        }
        $result = $reporter->afterSettingsSaved(null, $keys);
        self::assertCount(20, $result->checks ?? []);
        self::assertSame('A', array_key_first($result->checks ?? []));
        $body = json_decode((string) $fakes->reports[0]->body, true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($body);
        self::assertIsArray($body['api_keys']);
        self::assertCount(20, $body['api_keys']);
    }
}
