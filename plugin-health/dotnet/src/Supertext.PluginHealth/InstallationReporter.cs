using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace Supertext.PluginHealth;

/// <summary>The outcome of an <see cref="InstallationReporter"/> call.</summary>
/// <param name="State">Store this.</param>
/// <param name="Check">The latest key check (show it on the settings or status page).</param>
/// <param name="Event">The event that was reported (or tried), one of <see cref="ReportEvents"/>; null when nothing was due.</param>
/// <param name="Sent">Whether the center accepted the report.</param>
public sealed record ReporterResult(ReporterState State, KeyCheck? Check, string? Event, bool Sent)
{
    /// <summary>Several keys: the latest check per name; null with one key (then <see cref="Check"/> is set).</summary>
    public IReadOnlyList<NamedKeyCheck>? Checks { get; init; }
}

/// <summary>Options for <see cref="InstallationReporter"/>.</summary>
public sealed class ReporterOptions
{
    /// <summary>The "Send version information to Supertext" setting combined with the environment: see <see cref="Reporting.ReportsEnabled(bool?)"/>.</summary>
    public required bool Enabled { get; init; }

    /// <summary>Base URL of the installation, as the system knows it.</summary>
    public required string SiteUrl { get; init; }

    /// <summary><c>Name</c> = the plugin's GitHub repository name; <c>Version</c> from its official version source.</summary>
    public required NameVersion Plugin { get; init; }

    /// <summary>The CMS, PIM, shop or application, in its own spelling.</summary>
    public required NameVersion System { get; init; }

    /// <summary>The Supertext SDK's key check: see <see cref="IKeyChecker"/> and <see cref="PluginHealth.KeyChecker.FromDelegates"/>.</summary>
    public required IKeyChecker KeyChecker { get; init; }

    /// <summary>The bundled Supertext SDK's version (its <c>SdkInfo.Version</c>); null: no <c>sdk_version</c> in the report.</summary>
    public string? SdkVersion { get; init; }

    /// <summary>Default: <c>.NET</c> and <see cref="Environment.Version"/>.</summary>
    public NameVersion? Runtime { get; init; }

    /// <summary>The plugin's public ping endpoint; null for hosted apps without one.</summary>
    public string? CallbackUrl { get; init; }

    /// <summary>Default: <c>SUPERTEXT_REPORT_URL</c> from the environment, else <see cref="Reporting.DefaultReportUrl"/>.</summary>
    public string? ReportUrl { get; init; }

    /// <summary>HttpClient for the report. Default: a shared client.</summary>
    public HttpClient? HttpClient { get; init; }

    /// <summary>Clock. Default <see cref="TimeProvider.System"/>.</summary>
    public TimeProvider? TimeProvider { get; init; }
}

/// <summary>
/// Reports versions and the API key status to the Supertext Plugin Health dashboard (plugin-health/spec/reporter.json).
/// Stateless: load the plugin's stored <see cref="ReporterState"/>, pass it in, store the one you get back.
/// Never throws (except when the caller's token is cancelled), and never sends the API key or its fingerprint.
/// </summary>
public sealed class InstallationReporter
{
    private static readonly Lazy<HttpClient> SharedHttpClient = new(() => new HttpClient());

    private readonly ReporterOptions options;
    private readonly TimeProvider clock;
    private readonly HttpClient http;
    private readonly NameVersion runtime;

    /// <summary>Creates a reporter.</summary>
    public InstallationReporter(ReporterOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(options.KeyChecker);
        this.options = options;
        clock = options.TimeProvider ?? TimeProvider.System;
        http = options.HttpClient ?? SharedHttpClient.Value;
        runtime = options.Runtime ?? new NameVersion(".NET", Environment.Version.ToString());
        ReportUrl = NonEmpty(options.ReportUrl) ?? NonEmpty(Environment.GetEnvironmentVariable("SUPERTEXT_REPORT_URL")) ?? Reporting.DefaultReportUrl;
    }

    /// <summary>Where reports go.</summary>
    public string ReportUrl { get; }

    /// <summary>Whether reports are sent (the ping endpoint answers only then).</summary>
    public bool Enabled => options.Enabled;

    /// <summary><c>&lt;plugin&gt;|&lt;system&gt;|&lt;runtime&gt;</c> versions.</summary>
    public string Versions => string.Join('|', options.Plugin.Version ?? string.Empty, options.System.Version ?? string.Empty, runtime.Version ?? string.Empty);

    /// <summary>At most this many named keys are checked and reported; the rest are ignored.</summary>
    public const int MaxApiKeys = 20;

    /// <summary>After the plugin's settings were saved: checks the key, reports <c>installed</c> or <c>settings_saved</c>.</summary>
    public Task<ReporterResult> AfterSettingsSavedAsync(ReporterState? state, string? apiKey, CancellationToken cancellationToken = default) =>
        AfterSettingsSavedAsync(state, new Keys(apiKey, null), cancellationToken);

    /// <summary>The same for several keys, by name in the order the settings show them (e.g. "AI translation").</summary>
    public Task<ReporterResult> AfterSettingsSavedAsync(ReporterState? state, IEnumerable<KeyValuePair<string, string>> apiKeys, CancellationToken cancellationToken = default) =>
        AfterSettingsSavedAsync(state, new Keys(null, Named(apiKeys)), cancellationToken);

    /// <summary>On back-end requests that run the plugin's code: checks a changed key, reports what changed.</summary>
    public Task<ReporterResult> OnRequestAsync(ReporterState? state, string? apiKey, CancellationToken cancellationToken = default) =>
        OnRequestAsync(state, new Keys(apiKey, null), cancellationToken);

    /// <summary>The same for several keys, by name.</summary>
    public Task<ReporterResult> OnRequestAsync(ReporterState? state, IEnumerable<KeyValuePair<string, string>> apiKeys, CancellationToken cancellationToken = default) =>
        OnRequestAsync(state, new Keys(null, Named(apiKeys)), cancellationToken);

    /// <summary>A translation was rejected with 401/403: the key is invalid (the checker is not called).</summary>
    public Task<ReporterResult> AuthenticationFailedAsync(ReporterState? state, string? apiKey, int httpStatus = 401, CancellationToken cancellationToken = default) =>
        AuthenticationFailedAsync(state, new Keys(apiKey, null), httpStatus, null, cancellationToken);

    /// <summary>The same for several keys: only <paramref name="keyName"/> becomes invalid (null: all).</summary>
    public Task<ReporterResult> AuthenticationFailedAsync(ReporterState? state, IEnumerable<KeyValuePair<string, string>> apiKeys, int httpStatus = 401, string? keyName = null, CancellationToken cancellationToken = default) =>
        AuthenticationFailedAsync(state, new Keys(null, Named(apiKeys)), httpStatus, keyName, cancellationToken);

    /// <summary>The "Test connection" button: checks the key, reports a change.</summary>
    public Task<ReporterResult> TestConnectionAsync(ReporterState? state, string? apiKey, CancellationToken cancellationToken = default) =>
        TestConnectionAsync(state, new Keys(apiKey, null), cancellationToken);

    /// <summary>The same for several keys, by name.</summary>
    public Task<ReporterResult> TestConnectionAsync(ReporterState? state, IEnumerable<KeyValuePair<string, string>> apiKeys, CancellationToken cancellationToken = default) =>
        TestConnectionAsync(state, new Keys(null, Named(apiKeys)), cancellationToken);

    private sealed record Keys(string? Single, List<KeyValuePair<string, string>>? Many);

    private async Task<ReporterResult> AfterSettingsSavedAsync(ReporterState? state, Keys keys, CancellationToken cancellationToken)
    {
        var current = await WithChecksAsync(state ?? ReporterState.Empty, keys, true, cancellationToken).ConfigureAwait(false);
        return await ReportIfDueAsync(current, current.ReportedVersions is null ? ReportEvents.Installed : ReportEvents.SettingsSaved, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ReporterResult> OnRequestAsync(ReporterState? state, Keys keys, CancellationToken cancellationToken)
    {
        var current = await WithChecksAsync(state ?? ReporterState.Empty, keys, false, cancellationToken).ConfigureAwait(false);
        return await ReportIfDueAsync(current, DueEvent(current), cancellationToken).ConfigureAwait(false);
    }

    private async Task<ReporterResult> AuthenticationFailedAsync(ReporterState? state, Keys keys, int httpStatus, string? keyName, CancellationToken cancellationToken)
    {
        var baseState = state ?? ReporterState.Empty;
        KeyCheck Invalid(string? key) => new(KeyCheckStatus.Invalid, Reporting.IsoSeconds(clock.GetUtcNow()), httpStatus, null, FingerprintOf(key));
        ReporterState current;
        if (keys.Many is null)
        {
            current = baseState with
            {
                KeyCheck = Invalid(keys.Single),
                KeyChecks = null,
                ReportedKeyStatuses = null,
                ReportedKeyStatus = baseState.KeyChecks is not null ? null : baseState.ReportedKeyStatus,
            };
        }
        else
        {
            current = await WithChecksAsync(baseState, keys, false, cancellationToken).ConfigureAwait(false);
            var wanted = keyName?.Trim();
            var checks = current.KeyChecks!
                .Select(c => wanted is null || c.Name == wanted ? c with { Check = Invalid(keys.Many.First(k => k.Key == c.Name).Value) } : c)
                .ToList();
            current = current with { KeyChecks = checks };
        }
        return await ReportIfDueAsync(current, DueEvent(current), cancellationToken).ConfigureAwait(false);
    }

    private async Task<ReporterResult> TestConnectionAsync(ReporterState? state, Keys keys, CancellationToken cancellationToken)
    {
        var current = await WithChecksAsync(state ?? ReporterState.Empty, keys, true, cancellationToken).ConfigureAwait(false);
        return await ReportIfDueAsync(current, DueEvent(current), cancellationToken).ConfigureAwait(false);
    }

    /// <summary>The state with fresh checks: always (<paramref name="force"/>), else only for keys that are new or changed.</summary>
    private async Task<ReporterState> WithChecksAsync(ReporterState state, Keys keys, bool force, CancellationToken cancellationToken)
    {
        if (keys.Many is null)
        {
            if (!force && state.KeyChecks is null && state.KeyCheck is not null && state.KeyCheck.Fingerprint == FingerprintOf(keys.Single))
            {
                return state;
            }
            // Coming from several keys: report the single key even if its status is the one reported before.
            return state with
            {
                KeyCheck = await CheckAsync(keys.Single, cancellationToken).ConfigureAwait(false),
                KeyChecks = null,
                ReportedKeyStatuses = null,
                ReportedKeyStatus = state.KeyChecks is not null ? null : state.ReportedKeyStatus,
            };
        }
        var checks = new List<NamedKeyCheck>();
        foreach (var (name, key) in keys.Many)
        {
            var old = state.KeyChecks?.FirstOrDefault(c => c.Name == name)?.Check;
            checks.Add(new NamedKeyCheck(name, !force && old is not null && old.Fingerprint == FingerprintOf(key) ? old : await CheckAsync(key, cancellationToken).ConfigureAwait(false)));
        }
        return state with { KeyCheck = null, KeyChecks = checks };
    }

    /// <summary>The named keys (at most <see cref="MaxApiKeys"/>, names trimmed, blank and repeated names dropped).</summary>
    private static List<KeyValuePair<string, string>> Named(IEnumerable<KeyValuePair<string, string>> apiKeys)
    {
        ArgumentNullException.ThrowIfNull(apiKeys);
        var output = new List<KeyValuePair<string, string>>();
        foreach (var (raw, key) in apiKeys)
        {
            var name = (raw ?? string.Empty).Trim();
            name = name.Length > 60 ? name[..60] : name;
            if (name.Length == 0 || output.Exists(k => k.Key == name))
            {
                continue;
            }
            output.Add(new KeyValuePair<string, string>(name, key ?? string.Empty));
            if (output.Count >= MaxApiKeys)
            {
                break;
            }
        }
        return output;
    }

    /// <summary>Sends a <c>check</c> report now (commands, tests), even after a recent failure.</summary>
    public Task<ReporterResult> ReportCheckAsync(ReporterState? state, CancellationToken cancellationToken = default) =>
        SendAsync(state ?? ReporterState.Empty, ReportEvents.Check, cancellationToken);

    /// <summary>The report body for an event (one of <see cref="ReportEvents"/>) and state.</summary>
    public JsonObject BuildReport(string reportEvent, ReporterState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        var body = new JsonObject
        {
            ["schema"] = 1,
            ["event"] = reportEvent,
            ["site_url"] = options.SiteUrl,
            ["plugin"] = new JsonObject { ["name"] = options.Plugin.Name, ["version"] = options.Plugin.Version ?? string.Empty },
            ["system"] = NameVersionJson(options.System),
            ["runtime"] = NameVersionJson(runtime),
        };
        if (!string.IsNullOrEmpty(options.SdkVersion))
        {
            body["sdk_version"] = options.SdkVersion;
        }
        if (state.KeyChecks is { } checks)
        {
            var keys = new JsonArray();
            foreach (var named in checks)
            {
                keys.Add(new JsonObject
                {
                    ["name"] = named.Name,
                    ["configured"] = !string.IsNullOrEmpty(named.Check.Fingerprint),
                    ["check"] = CheckJson(named.Check),
                });
            }
            body["api_keys"] = keys;
        }
        else if (state.KeyCheck is { } check)
        {
            body["api_key_configured"] = !string.IsNullOrEmpty(check.Fingerprint);
            body["api_key_check"] = CheckJson(check);
        }
        if (!string.IsNullOrEmpty(options.CallbackUrl))
        {
            body["callback"] = new JsonObject { ["url"] = options.CallbackUrl };
        }
        return body;
    }

    private string? DueEvent(ReporterState state)
    {
        if (state.ReportedVersions is null)
        {
            return ReportEvents.Installed;
        }
        if (state.ReportedVersions != Versions)
        {
            return ReportEvents.Upgraded;
        }
        if (state.KeyChecks is { } checks)
        {
            var reported = state.ReportedKeyStatuses ?? new Dictionary<string, string>();
            return reported.Count != checks.Count || checks.Any(c => !reported.TryGetValue(c.Name, out var s) || s != c.Check.Status)
                ? ReportEvents.ApiKeyCheck
                : null;
        }
        if (state.KeyCheck is not null && state.KeyCheck.Status != state.ReportedKeyStatus)
        {
            return ReportEvents.ApiKeyCheck;
        }
        return null;
    }

    private static JsonObject CheckJson(KeyCheck check)
    {
        var c = new JsonObject { ["status"] = check.Status, ["checked_at"] = check.CheckedAt };
        if (check.HttpStatus is { } httpStatus)
        {
            c["http_status"] = httpStatus;
        }
        if (check.ErrorCode is { } errorCode)
        {
            c["error_code"] = errorCode;
        }
        return c;
    }

    private string FingerprintOf(string? apiKey)
    {
        try
        {
            return options.KeyChecker.Fingerprint(apiKey) ?? string.Empty;
        }
        catch
        {
            return string.Empty; // The SDK's fingerprint never throws; a plugin's own checker might.
        }
    }

    private async Task<KeyCheck> CheckAsync(string? apiKey, CancellationToken cancellationToken)
    {
        try
        {
            var check = await options.KeyChecker.CheckAsync(apiKey, cancellationToken).ConfigureAwait(false);
            if (check is { Status: not null, CheckedAt: not null })
            {
                return check.Fingerprint is null ? check with { Fingerprint = string.Empty } : check;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            // The SDK's check never throws; a plugin's own checker might.
        }
        return new KeyCheck(KeyCheckStatus.Error, Reporting.IsoSeconds(clock.GetUtcNow()), null, null, FingerprintOf(apiKey));
    }

    private Task<ReporterResult> ReportIfDueAsync(ReporterState state, string? reportEvent, CancellationToken cancellationToken)
    {
        if (reportEvent is null || !options.Enabled)
        {
            return Task.FromResult(new ReporterResult(state, state.KeyCheck, null, false) { Checks = state.KeyChecks });
        }
        if (state.LastFailureAt is not null
            && DateTimeOffset.TryParse(state.LastFailureAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var failed)
            && clock.GetUtcNow() - failed < Reporting.FailureBackoff)
        {
            return Task.FromResult(new ReporterResult(state, state.KeyCheck, null, false) { Checks = state.KeyChecks });
        }
        return SendAsync(state, reportEvent, cancellationToken);
    }

    private async Task<ReporterResult> SendAsync(ReporterState state, string reportEvent, CancellationToken cancellationToken)
    {
        if (!options.Enabled)
        {
            return new ReporterResult(state, state.KeyCheck, null, false) { Checks = state.KeyChecks };
        }
        bool ok;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Reporting.ReportTimeout);
            var content = new ByteArrayContent(Encoding.UTF8.GetBytes(BuildReport(reportEvent, state).ToJsonString()));
            content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(ReportUrl, UriKind.Absolute)) { Content = content };
            request.Headers.TryAddWithoutValidation("Accept", "application/json");
            request.Headers.TryAddWithoutValidation("User-Agent", $"supertext-plugin-health/{PluginHealthInfo.Version} (dotnet) {options.Plugin.Name}/{options.Plugin.Version}");
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
            ok = (int)response.StatusCode is >= 200 and < 300;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            ok = false; // Never fails the caller: the center is optional.
        }
        var next = ok
            ? state with
            {
                ReportedVersions = Versions,
                ReportedKeyStatus = state.KeyCheck?.Status ?? state.ReportedKeyStatus,
                ReportedKeyStatuses = state.KeyChecks is { } checks ? checks.ToDictionary(c => c.Name, c => c.Check.Status) : state.ReportedKeyStatuses,
                LastFailureAt = null,
            }
            : state with { LastFailureAt = Reporting.IsoSeconds(clock.GetUtcNow()) };
        return new ReporterResult(next, next.KeyCheck, reportEvent, ok) { Checks = next.KeyChecks };
    }

    private static JsonObject NameVersionJson(NameVersion value) =>
        string.IsNullOrEmpty(value.Version)
            ? new JsonObject { ["name"] = value.Name }
            : new JsonObject { ["name"] = value.Name, ["version"] = value.Version };

    private static string? NonEmpty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
