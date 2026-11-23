# Supertext Plugin Health for Java

Java version of [Supertext Plugin Health](../README.md): version reports to the Supertext Plugin Health dashboard, the API key check result and the plugin's ping endpoint. Package `com.supertext.pluginhealth`, Maven `com.supertext:supertext-plugin-health`. Java 17 or later, no runtime dependencies (only the JDK's `java.net.http`).

What a plugin does, the state it stores and the defaults are in the [package README](../README.md). In Java:

```java
InstallationReporter reporter = InstallationReporter.builder()
        .enabled(Reporting.reportsEnabled(settings.getVersionReports()))   // + SUPERTEXT_VERSION_REPORTS
        .siteUrl("https://cms.example.ch")
        .plugin("Magnolia-Supertext-Translation", PLUGIN_VERSION)
        .system("Magnolia", magnoliaVersion)
        .sdkVersion(SdkInfo.VERSION)                                        // null: no sdk_version
        .callbackUrl("https://cms.example.ch/.supertext/ping")              // null for hosted apps
        .keyChecker(KeyChecker.of(key -> {
            ApiKeyCheck c = SupertextClient.builder(key).build().checkApiKey();
            return new KeyCheck(c.getStatus().value(), c.getCheckedAt(), c.getHttpStatus(), c.getErrorCode(), c.getFingerprint());
        }, ApiKeyCheck::fingerprint))
        .build();

ReporterResult r = reporter.afterSettingsSaved(ReporterState.fromJson(stored), apiKey);
store(r.getState().toJson());
// onRequest(state, apiKey), authenticationFailed(state, apiKey[, 401]), testConnection(state, apiKey), reportCheck(state)

PingResponse p = PingResponse.forChallenge(request.getParameter("challenge"), "Magnolia-Supertext-Translation", reporter.enabled());
// answer with p.getStatus(), p.getHeaders() and p.getBody() as they are
```

Plugins bundle a copy of `src/main/java/com/supertext/pluginhealth/` renamed into their own package (`scripts/vendor-plugin-health.sh`). Everything lives in that one package, with no reflection and no service files.

## Testing

```sh
mvn -B verify
```

The tests (JUnit 5) read `../spec/reporter.json` and the dashboard's `../../spec/callback-vectors.json` and `../../spec/report-v1.schema.json`, so run them from this folder inside the repository. They use a fake key checker, a fake transport and a fixed clock. Nothing goes over the network.
