package com.supertext.pluginhealth;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * Version reports to the Supertext Plugin Health dashboard and the result of the API key check
 * (plugin-health/spec/reporter.json; protocol: the dashboard's docs/DEVELOPER.md → Report protocol).
 *
 * <p>The reporter is stateless and thread-safe: the plugin loads its {@link ReporterState}
 * ({@link ReporterState#fromJson(String)}), passes it in, and stores the state it gets back
 * ({@link ReporterResult#getState()}). It never talks to Supertext itself: the plugin passes a
 * {@link KeyChecker} built on the Supertext SDK. No call throws: the center is optional, and a failed
 * report is not tried again for {@link Reporting#FAILURE_BACKOFF}. Reports never contain the API key.</p>
 *
 * <pre>{@code
 * InstallationReporter reporter = InstallationReporter.builder()
 *         .enabled(Reporting.reportsEnabled(settings.getVersionReports()))
 *         .siteUrl("https://cms.example.ch")
 *         .plugin("Magnolia-Supertext-Translation", "0.2.0")
 *         .system("Magnolia", "6.4.10")
 *         .sdkVersion(SdkInfo.VERSION)
 *         .callbackUrl("https://cms.example.ch/.supertext/ping")
 *         .keyChecker(KeyChecker.of(key -> toKeyCheck(SupertextClient.builder(key).build().checkApiKey()), ApiKeyCheck::fingerprint))
 *         .build();
 * ReporterResult result = reporter.afterSettingsSaved(ReporterState.fromJson(stored), apiKey);
 * store(result.getState().toJson());
 * }</pre>
 */
public final class InstallationReporter {

    private final boolean enabled;
    private final String siteUrl;
    private final String pluginName;
    private final String pluginVersion;
    private final String systemName;
    private final String systemVersion;
    private final String runtimeName;
    private final String runtimeVersion;
    private final String sdkVersion;
    private final String callbackUrl;
    private final String reportUrl;
    private final KeyChecker keyChecker;
    private final Transport transport;
    private final Clock clock;

    private InstallationReporter(Builder b) {
        this.enabled = b.enabled;
        this.siteUrl = Objects.requireNonNull(b.siteUrl, "siteUrl");
        this.pluginName = Objects.requireNonNull(b.pluginName, "plugin name");
        this.pluginVersion = Objects.requireNonNull(b.pluginVersion, "plugin version");
        this.systemName = Objects.requireNonNull(b.systemName, "system name");
        this.systemVersion = b.systemVersion;
        this.keyChecker = Objects.requireNonNull(b.keyChecker, "keyChecker");
        if (b.runtimeName != null) {
            this.runtimeName = b.runtimeName;
            this.runtimeVersion = b.runtimeVersion;
        } else {
            this.runtimeName = "Java";
            this.runtimeVersion = javaVersion();
        }
        this.sdkVersion = b.sdkVersion == null || b.sdkVersion.isEmpty() ? null : b.sdkVersion;
        this.callbackUrl = b.callbackUrl == null || b.callbackUrl.isEmpty() ? null : b.callbackUrl;
        String url = b.reportUrl;
        if (url == null || url.isEmpty()) {
            url = System.getenv(Reporting.ENV_REPORT_URL);
        }
        this.reportUrl = url == null || url.trim().isEmpty() ? Reporting.DEFAULT_REPORT_URL : url.trim();
        this.transport = b.transport != null ? b.transport : new JdkHttpTransport();
        this.clock = b.clock != null ? b.clock : Clock.systemUTC();
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Whether reports are sent (the ping endpoint answers only then: {@link PingResponse#forChallenge}). */
    public boolean enabled() {
        return enabled;
    }

    /** Where reports go: the option, else {@code SUPERTEXT_REPORT_URL}, else {@link Reporting#DEFAULT_REPORT_URL}. */
    public String getReportUrl() {
        return reportUrl;
    }

    /** {@code <plugin>|<system>|<runtime>} versions (missing parts empty). */
    public String versions() {
        return pluginVersion + "|" + (systemVersion == null ? "" : systemVersion) + "|" + (runtimeVersion == null ? "" : runtimeVersion);
    }

    /** At most this many named keys are checked and reported; the rest are ignored. */
    public static final int MAX_API_KEYS = 20;

    /** After the plugin's settings were saved: checks the key, reports {@code installed} or {@code settings_saved}. */
    public ReporterResult afterSettingsSaved(ReporterState state, String apiKey) {
        ReporterState current = withChecks(orEmpty(state), apiKey, null, true);
        return reportIfDue(current, current.getReportedVersions() == null ? ReportEvent.INSTALLED : ReportEvent.SETTINGS_SAVED);
    }

    /** The same for several keys, by name in the order the settings show them (e.g. "AI translation"; use a LinkedHashMap). */
    public ReporterResult afterSettingsSaved(ReporterState state, Map<String, String> apiKeys) {
        ReporterState current = withChecks(orEmpty(state), null, named(apiKeys), true);
        return reportIfDue(current, current.getReportedVersions() == null ? ReportEvent.INSTALLED : ReportEvent.SETTINGS_SAVED);
    }

    /**
     * On back-end requests that run the plugin's code: checks the key only if it changed since the
     * last check (e.g. a new key from the environment), then reports what changed, if anything.
     */
    public ReporterResult onRequest(ReporterState state, String apiKey) {
        ReporterState current = withChecks(orEmpty(state), apiKey, null, false);
        return reportIfDue(current, dueEvent(current));
    }

    /** The same for several keys, by name: checks each key that changed. */
    public ReporterResult onRequest(ReporterState state, Map<String, String> apiKeys) {
        ReporterState current = withChecks(orEmpty(state), null, named(apiKeys), false);
        return reportIfDue(current, dueEvent(current));
    }

    /** A translation was rejected with 401 or 403: the key is {@code invalid} (the checker isn't called). */
    public ReporterResult authenticationFailed(ReporterState state, String apiKey, int httpStatus) {
        ReporterState base = orEmpty(state);
        ReporterState current = new ReporterState(base.getReportedVersions(),
                base.getKeyChecks() != null ? null : base.getReportedKeyStatus(), base.getLastFailureAt(), invalid(apiKey, httpStatus));
        return reportIfDue(current, dueEvent(current));
    }

    /** {@link #authenticationFailed(ReporterState, String, int)} with HTTP 401. */
    public ReporterResult authenticationFailed(ReporterState state, String apiKey) {
        return authenticationFailed(state, apiKey, 401);
    }

    /** The same for several keys: only {@code keyName} becomes invalid ({@code null}: all), the others keep their result. */
    public ReporterResult authenticationFailed(ReporterState state, Map<String, String> apiKeys, int httpStatus, String keyName) {
        Map<String, String> keys = named(apiKeys);
        ReporterState current = withChecks(orEmpty(state), null, keys, false);
        Map<String, KeyCheck> checks = new LinkedHashMap<>(current.getKeyChecks());
        String wanted = keyName == null ? null : keyName.trim();
        keys.forEach((name, key) -> {
            if (wanted == null || wanted.equals(name)) {
                checks.put(name, invalid(key, httpStatus));
            }
        });
        current = new ReporterState(current.getReportedVersions(), current.getReportedKeyStatus(), current.getLastFailureAt(), null,
                checks, current.getReportedKeyStatuses());
        return reportIfDue(current, dueEvent(current));
    }

    /** The "Test connection" button: checks the key again, reports a change. */
    public ReporterResult testConnection(ReporterState state, String apiKey) {
        ReporterState current = withChecks(orEmpty(state), apiKey, null, true);
        return reportIfDue(current, dueEvent(current));
    }

    /** The same for several keys, by name. */
    public ReporterResult testConnection(ReporterState state, Map<String, String> apiKeys) {
        ReporterState current = withChecks(orEmpty(state), null, named(apiKeys), true);
        return reportIfDue(current, dueEvent(current));
    }

    /** Sends a {@code check} report now (commands, tests), even within the failure backoff. */
    public ReporterResult reportCheck(ReporterState state) {
        return send(orEmpty(state), ReportEvent.CHECK);
    }

    /** The report body for an event and state (JSON: {@code Json} order, nested maps). */
    public Map<String, Object> buildReport(ReportEvent event, ReporterState state) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("schema", 1);
        body.put("event", event.value());
        body.put("site_url", siteUrl);
        body.put("plugin", nameVersion(pluginName, pluginVersion));
        body.put("system", nameVersion(systemName, systemVersion));
        body.put("runtime", nameVersion(runtimeName, runtimeVersion));
        if (sdkVersion != null) {
            body.put("sdk_version", sdkVersion);
        }
        ReporterState current = orEmpty(state);
        KeyCheck check = current.getKeyCheck();
        if (current.getKeyChecks() != null) {
            List<Object> keys = new ArrayList<>();
            current.getKeyChecks().forEach((name, c) -> {
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("name", name);
                entry.put("configured", !c.fingerprint().isEmpty());
                entry.put("check", checkBody(c));
                keys.add(entry);
            });
            body.put("api_keys", keys);
        } else if (check != null) {
            body.put("api_key_configured", !check.fingerprint().isEmpty());
            body.put("api_key_check", checkBody(check));
        }
        if (callbackUrl != null) {
            Map<String, Object> callback = new LinkedHashMap<>();
            callback.put("url", callbackUrl);
            body.put("callback", callback);
        }
        return body;
    }

    /** {@link #buildReport(ReportEvent, ReporterState)} as compact JSON. */
    public String buildReportJson(ReportEvent event, ReporterState state) {
        return Json.write(buildReport(event, state));
    }

    // ---------------------------------------------------------------- internals

    private static Map<String, Object> checkBody(KeyCheck check) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("status", check.status());
        c.put("checked_at", check.checkedAt());
        if (check.httpStatus() != null) {
            c.put("http_status", check.httpStatus());
        }
        if (check.errorCode() != null) {
            c.put("error_code", check.errorCode());
        }
        return c;
    }

    /** The state with fresh checks: always ({@code force}), else only for keys that are new or changed. */
    private ReporterState withChecks(ReporterState state, String apiKey, Map<String, String> apiKeys, boolean force) {
        if (apiKeys == null) {
            KeyCheck last = state.getKeyCheck();
            if (!force && state.getKeyChecks() == null && last != null && last.fingerprint().equals(fingerprint(apiKey))) {
                return state;
            }
            // Coming from several keys: report the single key even if its status is the one reported before.
            return new ReporterState(state.getReportedVersions(), state.getKeyChecks() != null ? null : state.getReportedKeyStatus(),
                    state.getLastFailureAt(), check(apiKey));
        }
        Map<String, KeyCheck> checks = new LinkedHashMap<>();
        apiKeys.forEach((name, key) -> {
            KeyCheck old = state.getKeyChecks() == null ? null : state.getKeyChecks().get(name);
            checks.put(name, !force && old != null && old.fingerprint().equals(fingerprint(key)) ? old : check(key));
        });
        return new ReporterState(state.getReportedVersions(), state.getReportedKeyStatus(), state.getLastFailureAt(), null, checks,
                state.getReportedKeyStatuses());
    }

    /** The named keys (at most {@link #MAX_API_KEYS}, names trimmed, blank and repeated names dropped), in order. */
    private static Map<String, String> named(Map<String, String> apiKeys) {
        Map<String, String> out = new LinkedHashMap<>();
        if (apiKeys == null) {
            return out;
        }
        for (Map.Entry<String, String> e : apiKeys.entrySet()) {
            String name = e.getKey() == null ? "" : e.getKey().trim();
            if (name.length() > 60) {
                name = name.substring(0, 60);
            }
            if (name.isEmpty() || out.containsKey(name)) {
                continue;
            }
            out.put(name, e.getValue() == null ? "" : e.getValue());
            if (out.size() >= MAX_API_KEYS) {
                break;
            }
        }
        return out;
    }

    private KeyCheck invalid(String apiKey, int httpStatus) {
        return new KeyCheck("invalid", KeyCheck.isoSeconds(clock.instant()), httpStatus, null, fingerprint(apiKey));
    }

    private KeyCheck check(String apiKey) {
        try {
            KeyCheck check = keyChecker.check(apiKey);
            if (check != null) {
                return check;
            }
        } catch (RuntimeException e) {
            // The SDK's check never throws; a plugin's own checker might.
        }
        return new KeyCheck("error", KeyCheck.isoSeconds(clock.instant()), null, null, fingerprint(apiKey));
    }

    private String fingerprint(String apiKey) {
        try {
            String fingerprint = keyChecker.fingerprint(apiKey);
            return fingerprint == null ? "" : fingerprint;
        } catch (RuntimeException e) {
            return "";
        }
    }

    private ReportEvent dueEvent(ReporterState state) {
        if (state.getReportedVersions() == null) {
            return ReportEvent.INSTALLED;
        }
        if (!state.getReportedVersions().equals(versions())) {
            return ReportEvent.UPGRADED;
        }
        if (state.getKeyChecks() != null) {
            Map<String, String> reported = state.getReportedKeyStatuses() == null ? Map.of() : state.getReportedKeyStatuses();
            if (reported.size() != state.getKeyChecks().size()) {
                return ReportEvent.API_KEY_CHECK;
            }
            for (Map.Entry<String, KeyCheck> e : state.getKeyChecks().entrySet()) {
                if (!e.getValue().status().equals(reported.get(e.getKey()))) {
                    return ReportEvent.API_KEY_CHECK;
                }
            }
            return null;
        }
        KeyCheck check = state.getKeyCheck();
        if (check != null && !check.status().equals(state.getReportedKeyStatus())) {
            return ReportEvent.API_KEY_CHECK;
        }
        return null;
    }

    private ReporterResult reportIfDue(ReporterState state, ReportEvent event) {
        if (event == null || !enabled) {
            return new ReporterResult(state, null, false);
        }
        if (state.getLastFailureAt() != null) {
            try {
                Instant failed = Instant.parse(state.getLastFailureAt());
                if (Duration.between(failed, clock.instant()).compareTo(Reporting.FAILURE_BACKOFF) < 0) {
                    return new ReporterResult(state, null, false);
                }
            } catch (DateTimeParseException e) {
                // Unreadable time: try again.
            }
        }
        return send(state, event);
    }

    private ReporterResult send(ReporterState state, ReportEvent event) {
        if (!enabled) {
            return new ReporterResult(state, null, false);
        }
        boolean ok = false;
        try {
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("Content-Type", "application/json");
            headers.put("Accept", "application/json");
            headers.put("User-Agent", "supertext-plugin-health/" + PluginHealthInfo.VERSION + " (java) " + pluginName + "/" + pluginVersion);
            byte[] body = buildReportJson(event, state).getBytes(StandardCharsets.UTF_8);
            int status = transport.send(new Transport.Request("POST", URI.create(reportUrl), headers, body, Reporting.REPORT_TIMEOUT));
            ok = status >= 200 && status < 300;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (IOException | RuntimeException e) {
            // Never fails the caller: the center is optional.
        }
        ReporterState next;
        if (ok) {
            KeyCheck check = state.getKeyCheck();
            Map<String, String> statuses = state.getReportedKeyStatuses();
            if (state.getKeyChecks() != null) {
                statuses = new LinkedHashMap<>();
                for (Map.Entry<String, KeyCheck> e : state.getKeyChecks().entrySet()) {
                    statuses.put(e.getKey(), e.getValue().status());
                }
            }
            next = new ReporterState(versions(), check != null ? check.status() : state.getReportedKeyStatus(), null, check,
                    state.getKeyChecks(), statuses);
        } else {
            next = new ReporterState(state.getReportedVersions(), state.getReportedKeyStatus(),
                    KeyCheck.isoSeconds(clock.instant()), state.getKeyCheck(), state.getKeyChecks(), state.getReportedKeyStatuses());
        }
        return new ReporterResult(next, event, ok);
    }

    private static ReporterState orEmpty(ReporterState state) {
        return state == null ? ReporterState.EMPTY : state;
    }

    private static Map<String, Object> nameVersion(String name, String version) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("name", name);
        if (version != null && !version.isEmpty()) {
            map.put("version", version);
        }
        return map;
    }

    /** {@link Runtime#version()} as dotted numbers ({@code 21.0.4}), without build or pre-release parts. */
    static String javaVersion() {
        return Runtime.version().version().stream().map(String::valueOf).collect(Collectors.joining("."));
    }

    @Override
    public String toString() {
        return "InstallationReporter{plugin=" + pluginName + "/" + pluginVersion + ", enabled=" + enabled + ", reportUrl=" + reportUrl + "}";
    }

    // ---------------------------------------------------------------- builder

    /** Options for {@link InstallationReporter}. Required: {@code siteUrl}, {@code plugin}, {@code system}, {@code keyChecker}. */
    public static final class Builder {
        private boolean enabled = true;
        private String siteUrl;
        private String pluginName;
        private String pluginVersion;
        private String systemName;
        private String systemVersion;
        private String runtimeName;
        private String runtimeVersion;
        private String sdkVersion;
        private String callbackUrl;
        private String reportUrl;
        private KeyChecker keyChecker;
        private Transport transport;
        private Clock clock;

        private Builder() {
        }

        /** The "Send version information to Supertext" setting combined with the environment: {@link Reporting#reportsEnabled(Boolean)}. Default on. */
        public Builder enabled(boolean enabled) {
            this.enabled = enabled;
            return this;
        }

        /** Base URL of the installation, as the system knows it. */
        public Builder siteUrl(String siteUrl) {
            this.siteUrl = siteUrl;
            return this;
        }

        /** The plugin's GitHub repository name and its version from the official version source. */
        public Builder plugin(String name, String version) {
            this.pluginName = name;
            this.pluginVersion = version;
            return this;
        }

        /** The CMS, PIM, shop or application, in its own spelling; version may be {@code null}. */
        public Builder system(String name, String version) {
            this.systemName = name;
            this.systemVersion = version;
            return this;
        }

        /** Default: {@code Java} and {@link Runtime#version()}. */
        public Builder runtime(String name, String version) {
            this.runtimeName = name;
            this.runtimeVersion = version;
            return this;
        }

        /** The bundled Supertext SDK's version ({@code SdkInfo.VERSION}); {@code null}: no {@code sdk_version} in reports. */
        public Builder sdkVersion(String sdkVersion) {
            this.sdkVersion = sdkVersion;
            return this;
        }

        /** The SDK's key check: see {@link KeyChecker}. Required. */
        public Builder keyChecker(KeyChecker keyChecker) {
            this.keyChecker = keyChecker;
            return this;
        }

        /** The plugin's public ping endpoint ({@link PingResponse}); {@code null} for hosted apps without one. */
        public Builder callbackUrl(String callbackUrl) {
            this.callbackUrl = callbackUrl;
            return this;
        }

        /** Default: {@code SUPERTEXT_REPORT_URL} from the environment, else {@link Reporting#DEFAULT_REPORT_URL}. */
        public Builder reportUrl(String reportUrl) {
            this.reportUrl = reportUrl;
            return this;
        }

        /** HTTP for the report (default {@link JdkHttpTransport}). */
        public Builder transport(Transport transport) {
            this.transport = transport;
            return this;
        }

        /** Wall clock for check times and the failure backoff (default {@link Clock#systemUTC()}). */
        public Builder clock(Clock clock) {
            this.clock = clock;
            return this;
        }

        public InstallationReporter build() {
            return new InstallationReporter(this);
        }
    }
}
