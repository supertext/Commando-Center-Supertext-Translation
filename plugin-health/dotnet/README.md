# Supertext Plugin Health for .NET

The .NET version of [Supertext Plugin Health](../README.md): version reports to the Supertext Plugin Health dashboard, the API key check result and the plugin's ping endpoint answer. Namespace `Supertext.PluginHealth`, no dependencies beyond the BCL. Usage, concepts and bundling: [`../README.md`](../README.md).

```csharp
using Supertext.Sdk;
using Supertext.Sdk.V1;
using Supertext.PluginHealth; // in a plugin: its renamed copy, e.g. Supertext.OrchardCore.Translation.PluginHealth

var reporter = new InstallationReporter(new ReporterOptions
{
    Enabled = Reporting.ReportsEnabled(settings.VersionReports),
    SiteUrl = "https://www.example.ch",
    Plugin = new NameVersion("OrchardCore-Supertext-Translation", pluginVersion),
    System = new NameVersion("Orchard Core", orchardVersion),
    SdkVersion = SdkInfo.Version,
    CallbackUrl = "https://www.example.ch/supertext/ping", // null for hosted apps
    KeyChecker = KeyChecker.FromDelegates(
        async (key, ct) =>
        {
            var c = await new SupertextClient(key).CheckApiKeyAsync(ct);
            return new KeyCheck(c.Status, c.CheckedAt, c.HttpStatus, c.ErrorCode, c.Fingerprint);
        },
        ApiKeyCheck.FingerprintOf),
});

var r = await reporter.AfterSettingsSavedAsync(ReporterState.FromJson(stored), apiKey);
Store(r.State.ToJson());
// OnRequestAsync, AuthenticationFailedAsync(state, key, 401), TestConnectionAsync, ReportCheckAsync

var ping = PingResponse.For(query["challenge"], "OrchardCore-Supertext-Translation", reporter.Enabled);
// answer with ping.Status, ping.Headers and ping.Body as they are
```

Plugins compile the files in `src/Supertext.PluginHealth/` into their own assembly with the namespace renamed; everything lives in that one namespace and the tests use only the public API.

## Target frameworks

`net8.0` (like the Supertext .NET SDK). Needs the .NET 8 SDK or newer.

## Testing

```sh
dotnet build -warnaserror
dotnet test
```

The tests run the shared vectors: [`../spec/reporter.json`](../spec/reporter.json) (defaults, setting, ping, every reporter scenario with a fake key checker and a fake center) and the dashboard's [`spec/callback-vectors.json`](../../spec/callback-vectors.json) (endpoint cases) and [`spec/report-v1.schema.json`](../../spec/report-v1.schema.json) (report fields). They also check that `PluginHealthInfo.Version` equals the csproj version and the TypeScript package version.
