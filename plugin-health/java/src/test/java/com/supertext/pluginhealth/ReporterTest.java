package com.supertext.pluginhealth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * ../spec/reporter.json and the dashboard's spec (../../spec: ping cases, report schema). That the
 * center accepts every report body is checked in the center's own tests with the TypeScript reference.
 */
class ReporterTest {

    private static final String REPORT_URL = "https://center.test/api/v1/report";
    private static final Map<String, Object> SPEC = load("../spec/reporter.json");
    private static final Map<String, Object> CONFIG = map(SPEC.get("config"));

    // ------------------------------------------------------------ helpers

    private static Map<String, Object> load(String path) {
        try {
            return map(Json.parse(Files.readString(Path.of(path), StandardCharsets.UTF_8)));
        } catch (IOException e) {
            throw new UncheckedIOException("spec file not found: " + Path.of(path).toAbsolutePath(), e);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Map<String, Object> map, String key) {
        return (List<Map<String, Object>>) map.get(key);
    }

    private static String str(Object value) {
        return (String) value;
    }

    private static Clock at(String iso) {
        return Clock.fixed(Instant.parse(iso), ZoneOffset.UTC);
    }

    /** The parsed JSON form of a check, as the spec writes it. */
    private static Object parsed(KeyCheck check) {
        return check == null ? null : Json.parse(Json.write(check.toMap()));
    }

    /** Fake key checker (returns the step's keyCheck) and fake center; records the calls in order. */
    static final class Fakes implements KeyChecker, Transport {
        final List<String> calls = new ArrayList<>();
        final List<Object> bodies = new ArrayList<>();
        final List<Request> requests = new ArrayList<>();
        private final Object keyCheck;
        private final Object report;

        private final java.util.ArrayDeque<Object> queue;

        Fakes(Object keyCheck, Object report) {
            this.keyCheck = keyCheck;
            this.report = report;
            this.queue = keyCheck instanceof List ? new java.util.ArrayDeque<>((List<?>) keyCheck) : null;
        }

        @Override
        public KeyCheck check(String apiKey) {
            calls.add("keyCheck");
            Object next = queue != null ? queue.poll() : keyCheck;
            if (next == null) {
                throw new AssertionError("unexpected key check");
            }
            return KeyCheck.fromMap(next);
        }

        @Override
        public String fingerprint(String apiKey) {
            Map<String, Object> fingerprints = map(SPEC.get("fingerprints"));
            if (!fingerprints.containsKey(apiKey)) {
                throw new AssertionError("no fingerprint for " + Json.write(apiKey));
            }
            return str(fingerprints.get(apiKey));
        }

        @Override
        public int send(Request request) throws IOException {
            calls.add("report");
            requests.add(request);
            assertEquals(REPORT_URL, request.getUri().toString());
            assertEquals("POST", request.getMethod());
            assertEquals(Reporting.REPORT_TIMEOUT, request.getTimeout());
            bodies.add(Json.parse(new String(request.getBody(), StandardCharsets.UTF_8)));
            if (!(report instanceof Map)) {
                throw new AssertionError("unexpected report");
            }
            Map<?, ?> a = (Map<?, ?>) report;
            if (Boolean.TRUE.equals(a.get("transportError"))) {
                throw new IOException("connection refused");
            }
            return a.get("status") == null ? 202 : ((Number) a.get("status")).intValue();
        }
    }

    private static InstallationReporter.Builder configured(Map<String, Object> config, KeyChecker checker) {
        Map<String, Object> plugin = map(config.get("plugin"));
        Map<String, Object> system = map(config.get("system"));
        InstallationReporter.Builder b = InstallationReporter.builder()
                .enabled(!Boolean.FALSE.equals(config.get("enabled")))
                .siteUrl(str(config.get("siteUrl")))
                .plugin(str(plugin.get("name")), str(plugin.get("version")))
                .system(str(system.get("name")), str(system.get("version")))
                .sdkVersion(str(config.get("sdkVersion")))
                .callbackUrl(str(config.get("callbackUrl")))
                .keyChecker(checker);
        if (config.get("runtime") != null) {
            Map<String, Object> runtime = map(config.get("runtime"));
            b.runtime(str(runtime.get("name")), str(runtime.get("version")));
        }
        return b;
    }

    private static String userAgent(Map<String, Object> config) {
        Map<String, Object> plugin = map(config.get("plugin"));
        return "supertext-plugin-health/" + PluginHealthInfo.VERSION + " (java) " + plugin.get("name") + "/" + plugin.get("version");
    }

    // ------------------------------------------------------------ ../spec/reporter.json

    @Test
    void defaults() {
        Map<String, Object> d = map(SPEC.get("defaults"));
        assertEquals(d.get("reportUrl"), Reporting.DEFAULT_REPORT_URL);
        assertEquals(((Number) d.get("reportTimeoutSeconds")).longValue(), Reporting.REPORT_TIMEOUT.getSeconds());
        assertEquals(((Number) d.get("failureBackoffSeconds")).longValue(), Reporting.FAILURE_BACKOFF.getSeconds());
    }

    @TestFactory
    Stream<DynamicTest> enabled() {
        return list(SPEC, "enabled").stream().map(c -> DynamicTest.dynamicTest("enabled " + Json.write(c),
                () -> assertEquals(c.get("out"), Reporting.reportsEnabled((Boolean) c.get("setting"), str(c.get("env"))))));
    }

    @TestFactory
    Stream<DynamicTest> ping() {
        Map<String, Object> ping = map(SPEC.get("ping"));
        String plugin = str(ping.get("plugin"));
        return list(ping, "cases").stream().map(c -> DynamicTest.dynamicTest(
                "ping " + Json.write(c.get("challenge")) + " enabled=" + c.get("enabled"), () -> {
                    PingResponse r = PingResponse.forChallenge(str(c.get("challenge")), plugin, Boolean.TRUE.equals(c.get("enabled")));
                    assertEquals(((Number) c.get("status")).intValue(), r.getStatus());
                    assertEquals(c.get("body"), Json.parse(r.getBody()));
                    Map<String, String> headers = new LinkedHashMap<>();
                    headers.put("Content-Type", "application/json");
                    headers.put("Cache-Control", "no-store");
                    assertEquals(headers, r.getHeaders());
                }));
    }

    @TestFactory
    Stream<DynamicTest> scenarios() {
        return list(SPEC, "scenarios").stream().map(scenario -> DynamicTest.dynamicTest(str(scenario.get("name")), () -> {
            Map<String, Object> config = new LinkedHashMap<>(CONFIG);
            if (scenario.get("config") != null) {
                config.putAll(map(scenario.get("config")));
            }
            ReporterState state = ReporterState.fromJson(Json.write(scenario.get("state")));
            for (Map<String, Object> step : list(scenario, "steps")) {
                String action = str(step.get("action"));
                Fakes f = new Fakes(step.get("keyChecks") != null ? step.get("keyChecks") : step.get("keyCheck"), step.get("report"));
                InstallationReporter reporter = configured(config, f)
                        .reportUrl(REPORT_URL)
                        .transport(f)
                        .clock(at(str(step.get("now"))))
                        .build();
                String apiKey = str(step.get("apiKey"));
                Map<String, String> named = null;
                if (step.get("apiKeys") != null) {
                    named = new LinkedHashMap<>();
                    for (Map.Entry<String, Object> e : map(step.get("apiKeys")).entrySet()) {
                        named.put(e.getKey(), str(e.getValue()));
                    }
                }
                ReporterResult r;
                switch (action) {
                    case "afterSettingsSaved":
                        r = named != null ? reporter.afterSettingsSaved(state, named) : reporter.afterSettingsSaved(state, apiKey);
                        break;
                    case "onRequest":
                        r = named != null ? reporter.onRequest(state, named) : reporter.onRequest(state, apiKey);
                        break;
                    case "authenticationFailed":
                        if (named != null) {
                            r = reporter.authenticationFailed(state, named, ((Number) step.get("httpStatus")).intValue(), str(step.get("keyName")));
                        } else {
                            r = step.get("httpStatus") == null ? reporter.authenticationFailed(state, apiKey)
                                    : reporter.authenticationFailed(state, apiKey, ((Number) step.get("httpStatus")).intValue());
                        }
                        break;
                    case "testConnection":
                        r = named != null ? reporter.testConnection(state, named) : reporter.testConnection(state, apiKey);
                        break;
                    case "reportCheck":
                        r = reporter.reportCheck(state);
                        break;
                    default:
                        throw new AssertionError("unknown action " + action);
                }
                Map<String, Object> expect = map(step.get("expect"));
                assertEquals(expect.get("calls"), f.calls, action + " calls");
                assertEquals(expect.get("event"), r.getEvent() == null ? null : r.getEvent().value(), action + " event");
                assertEquals(expect.get("sent"), r.isSent(), action + " sent");
                assertEquals(expect.get("check"), parsed(r.getCheck()), action + " check");
                Map<String, Object> checks = null;
                if (r.getChecks() != null) {
                    checks = new LinkedHashMap<>();
                    for (Map.Entry<String, KeyCheck> e : r.getChecks().entrySet()) {
                        checks.put(e.getKey(), parsed(e.getValue()));
                    }
                }
                assertEquals(expect.get("checks"), checks, action + " checks");
                assertEquals(expect.get("state"), Json.parse(r.getState().toJson()), action + " state");
                if (expect.get("reportBody") != null) {
                    assertEquals(expect.get("reportBody"), f.bodies.get(0), action + " report body");
                }
                for (Transport.Request request : f.requests) {
                    assertEquals(userAgent(config), request.getHeaders().get("User-Agent"));
                    assertEquals("application/json", request.getHeaders().get("Content-Type"));
                }
                // The stored form survives a JSON round trip.
                state = ReporterState.fromJson(r.getState().toJson());
                assertEquals(r.getState(), state);
                assertEquals(state, ReporterState.fromJson(Json.write(expect.get("state"))));
            }
        }));
    }

    // ------------------------------------------------------------ the center's spec (../../spec)

    @TestFactory
    Stream<DynamicTest> centerPingEndpoint() {
        Map<String, Object> endpoint = map(load("../../spec/callback-vectors.json").get("endpoint"));
        return list(endpoint, "cases").stream().map(c -> DynamicTest.dynamicTest("ping endpoint " + Json.write(c.get("challenge")), () -> {
            PingResponse r = PingResponse.forChallenge(str(c.get("challenge")), "Some-Supertext-Translation", true);
            assertEquals(((Number) c.get("status")).intValue(), r.getStatus());
            Map<String, Object> expected = new LinkedHashMap<>(map(c.get("body")));
            if (expected.containsKey("plugin")) {
                expected.put("plugin", "Some-Supertext-Translation");
            }
            assertEquals(expected, Json.parse(r.getBody()));
        }));
    }

    @Test
    void reportsHaveTheFieldsOfTheCenterSchema() {
        Map<String, Object> schema = load("../../spec/report-v1.schema.json");
        KeyCheck ok = new KeyCheck("ok", "2026-10-13T08:00:00Z", 200, null, "abc");
        for (ReporterState state : List.of(ReporterState.EMPTY, ReporterState.EMPTY.withKeyCheck(ok))) {
            Map<String, Object> body = map(Json.parse(configured(CONFIG, new Fakes(null, null)).build()
                    .buildReportJson(ReportEvent.SETTINGS_SAVED, state)));
            for (Object field : (List<?>) schema.get("required")) {
                assertTrue(body.containsKey(field), "missing " + field);
            }
            for (String field : body.keySet()) {
                assertTrue(map(schema.get("properties")).containsKey(field), "unknown " + field);
            }
        }
    }

    // ------------------------------------------------------------ reporter

    @Test
    void neverSendsTheKeyNorItsFingerprint() {
        Map<String, Object> okCheck = new LinkedHashMap<>();
        okCheck.put("status", "ok");
        okCheck.put("checkedAt", "2026-10-13T08:00:00Z");
        okCheck.put("httpStatus", 200.0);
        okCheck.put("fingerprint", "abc");
        Map<String, Object> accepted = new LinkedHashMap<>();
        accepted.put("status", 202.0);
        Fakes f = new Fakes(okCheck, accepted);
        ReporterResult r = configured(CONFIG, KeyChecker.of(f::check, key -> "abc")).reportUrl(REPORT_URL).transport(f).build()
                .afterSettingsSaved(null, "secret-key-123");
        assertTrue(r.isSent());
        String sent = Json.write(f.bodies);
        assertFalse(sent.contains("secret-key-123"));
        assertFalse(sent.contains("\"abc\""));
        assertFalse(r.getState().toJson().contains("secret-key-123"));
        assertFalse(r.toString().contains("secret-key-123"));
    }

    @Test
    void aThrowingCheckerGivesAnErrorCheck() {
        InstallationReporter reporter = configured(CONFIG, KeyChecker.of(key -> {
            throw new IllegalStateException("boom");
        }, key -> "fp")).enabled(false).clock(at("2026-10-13T08:00:00.700Z")).build();
        ReporterResult r = reporter.afterSettingsSaved(null, "k");
        assertEquals(new KeyCheck("error", "2026-10-13T08:00:00Z", null, null, "fp"), r.getCheck());
        assertFalse(r.isSent());
    }

    @Test
    void aCheckerReturningNullGivesAnErrorCheck() {
        InstallationReporter reporter = configured(CONFIG, KeyChecker.of(key -> null, key -> "fp")).enabled(false)
                .clock(at("2026-10-13T08:00:00Z")).build();
        assertEquals(new KeyCheck("error", "2026-10-13T08:00:00Z", null, null, "fp"), reporter.testConnection(null, "k").getCheck());
    }

    @Test
    void neverThrowsWhenTheTransportDoes() {
        InstallationReporter reporter = configured(CONFIG, KeyChecker.of(key -> null, key -> "fp")).reportUrl(REPORT_URL)
                .transport(request -> {
                    throw new IllegalStateException("boom");
                }).clock(at("2026-10-13T08:00:00Z")).build();
        ReporterResult r = reporter.afterSettingsSaved(ReporterState.EMPTY, "k1");
        assertFalse(r.isSent());
        assertEquals(ReportEvent.INSTALLED, r.getEvent());
        assertEquals("2026-10-13T08:00:00Z", r.getState().getLastFailureAt());
    }

    @Test
    void keepsTheInterruptFlag() {
        InstallationReporter reporter = configured(CONFIG, KeyChecker.of(key -> null, key -> "fp")).reportUrl(REPORT_URL)
                .transport(request -> {
                    throw new InterruptedException();
                }).build();
        try {
            assertFalse(reporter.reportCheck(null).isSent());
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    void withoutAnSdkVersionTheReportHasNoSdkVersion() {
        Map<String, Object> config = new LinkedHashMap<>(CONFIG);
        config.put("sdkVersion", null);
        Map<String, Object> body = configured(config, new Fakes(null, null)).build().buildReport(ReportEvent.CHECK, null);
        assertFalse(body.containsKey("sdk_version"));
        assertEquals("0.3.0", configured(CONFIG, new Fakes(null, null)).build().buildReport(ReportEvent.CHECK, null).get("sdk_version"));
    }

    @Test
    void treatsABrokenStoredStateAsEmpty() {
        assertEquals(ReporterState.EMPTY, ReporterState.fromJson("not json"));
        assertEquals(ReporterState.EMPTY, ReporterState.fromJson(null));
        assertEquals(ReporterState.EMPTY, ReporterState.fromJson("[1,2]"));
        assertNull(ReporterState.fromJson("{\"keyCheck\":{\"status\":\"ok\"}}").getKeyCheck());
        assertEquals("{\"reportedVersions\":null,\"reportedKeyStatus\":null,\"lastFailureAt\":null,\"keyCheck\":null,\"keyChecks\":null,\"reportedKeyStatuses\":null}",
                ReporterState.EMPTY.toJson());
    }

    @Test
    void readsAStateStoredByTheSdkReporter() {
        String old = "{\"reportedVersions\":\"0.2.0|12.0.0|22.11.0\",\"reportedKeyStatus\":\"ok\",\"lastFailureAt\":null,"
                + "\"keyCheck\":{\"status\":\"ok\",\"checkedAt\":\"2026-10-13T08:00:00Z\",\"httpStatus\":200,\"errorCode\":null,\"fingerprint\":\"abc\"}}";
        ReporterState state = ReporterState.fromJson(old);
        assertEquals(new ReporterState("0.2.0|12.0.0|22.11.0", "ok", null,
                new KeyCheck("ok", "2026-10-13T08:00:00Z", 200, null, "abc")), state);
        assertEquals(old.substring(0, old.length() - 1) + ",\"keyChecks\":null,\"reportedKeyStatuses\":null}", state.toJson());
    }

    @Test
    void checksAtMostTwentyNamedKeys() {
        List<Object> checks = new java.util.ArrayList<>();
        for (int n = 0; n < 30; n++) {
            checks.add(Json.parse("{\"status\":\"ok\",\"checkedAt\":\"2026-10-13T08:00:00Z\",\"httpStatus\":200,\"errorCode\":null,\"fingerprint\":\"k1\"}"));
        }
        Fakes f = new Fakes(checks, Json.parse("{\"status\":202}"));
        InstallationReporter reporter = configured(new LinkedHashMap<>(CONFIG), f).reportUrl(REPORT_URL).transport(f).build();
        Map<String, String> keys = new LinkedHashMap<>();
        keys.put(" ", "x");
        keys.put("A ", "k1");
        for (int n = 0; n < 25; n++) {
            keys.put("Key " + n, "k1");
        }
        ReporterResult r = reporter.afterSettingsSaved(null, keys);
        assertEquals(20, r.getChecks().size());
        assertEquals("A", r.getChecks().keySet().iterator().next());
        assertEquals(20, ((List<?>) map(f.bodies.get(0)).get("api_keys")).size());
    }

    @Test
    void detectsTheRuntime() {
        Map<String, Object> config = new LinkedHashMap<>(CONFIG);
        config.remove("runtime");
        InstallationReporter reporter = configured(config, new Fakes(null, null)).build();
        Map<String, Object> runtime = new LinkedHashMap<>();
        runtime.put("name", "Java");
        runtime.put("version", InstallationReporter.javaVersion());
        assertEquals(runtime, reporter.buildReport(ReportEvent.CHECK, ReporterState.EMPTY).get("runtime"));
        assertTrue(InstallationReporter.javaVersion().startsWith(Runtime.version().feature() + ""));
        assertTrue(reporter.versions().endsWith("|" + InstallationReporter.javaVersion()));
    }

    @Test
    void exposesEnabledAndVersions() {
        InstallationReporter reporter = configured(CONFIG, new Fakes(null, null)).build();
        assertTrue(reporter.enabled());
        assertEquals("0.2.0|12.0.0|22.11.0", reporter.versions());
        assertFalse(configured(CONFIG, new Fakes(null, null)).enabled(false).build().enabled());
    }

    @Test
    void versionMatchesThePomAndTheTypeScriptPackage() throws IOException {
        assertEquals(PluginHealthInfo.VERSION, load("../typescript/package.json").get("version"));
        String pom = Files.readString(Path.of("pom.xml"), StandardCharsets.UTF_8);
        Matcher m = Pattern.compile("<artifactId>supertext-plugin-health</artifactId>\\s*<version>([^<]+)</version>").matcher(pom);
        assertTrue(m.find());
        assertEquals(PluginHealthInfo.VERSION, m.group(1));
    }

    @Test
    void jsonWriterRoundTrips() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("text", "quote \" backslash \\ newline \n tab \t ctrl \u0001 umlaut Ä");
        value.put("int", 200);
        value.put("whole", 3.0);
        value.put("list", java.util.Arrays.asList(true, null, "x"));
        String json = Json.write(value);
        assertTrue(json.contains("\"whole\":3,"));
        Map<String, Object> back = map(Json.parse(json));
        assertEquals(value.get("text"), back.get("text"));
        assertEquals(200.0, back.get("int"));
        assertEquals(value.get("list"), back.get("list"));
    }
}
