using System.Net;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Supertext.PluginHealth.Tests;

/// <summary>
/// plugin-health/spec/reporter.json and the dashboard's spec (callback-vectors.json endpoint cases,
/// report-v1.schema.json). That the center accepts every report body is checked in the center's own tests.
/// </summary>
public class ReporterTests
{
    private const string ReportUrl = "https://center.test/api/v1/report";

    private static readonly JsonElement S = Spec.Load("reporter.json");

    public static IEnumerable<object[]> EnabledCases() => Spec.Cases(S.GetProperty("enabled"), "enabled");
    public static IEnumerable<object[]> PingCases() => Spec.Cases(S.GetProperty("ping").GetProperty("cases"), "ping");
    public static IEnumerable<object[]> ScenarioCases() => Spec.Cases(S.GetProperty("scenarios"), "scenarios", "name");
    public static IEnumerable<object[]> EndpointCases() => Spec.Cases(Spec.Center("callback-vectors.json").GetProperty("endpoint").GetProperty("cases"), "endpoint");

    [Fact]
    public void HasTheSpecDefaults()
    {
        var d = S.GetProperty("defaults");
        Assert.Equal(Reporting.DefaultReportUrl, d.Str("reportUrl"));
        Assert.Equal(TimeSpan.FromSeconds(d.GetProperty("reportTimeoutSeconds").GetInt32()), Reporting.ReportTimeout);
        Assert.Equal(TimeSpan.FromSeconds(d.GetProperty("failureBackoffSeconds").GetInt32()), Reporting.FailureBackoff);
    }

    [Fact]
    public void VersionIsTheSharedOne()
    {
        Assert.Equal(PluginHealthInfo.Version, Spec.TypeScriptPackage().Str("version"));
        Assert.Equal(PluginHealthInfo.Version, typeof(InstallationReporter).Assembly.GetName().Version!.ToString(3));
    }

    [Fact]
    public void ReportUrlDefaultsToTheEnvironmentOrTheLiveCenter()
    {
        var reporter = Reporter(Config(), new FakeCenter(null), TimeProvider.System, FakeChecker(null), reportUrl: null);
        var env = Environment.GetEnvironmentVariable("SUPERTEXT_REPORT_URL");
        Assert.Equal(string.IsNullOrWhiteSpace(env) ? Reporting.DefaultReportUrl : env.Trim(), reporter.ReportUrl);
    }

    [Theory]
    [MemberData(nameof(EnabledCases))]
    public void Enabled(string name, string json)
    {
        _ = name;
        var c = JsonDocument.Parse(json).RootElement;
        bool? setting = c.GetProperty("setting").ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null };
        Assert.Equal(c.GetProperty("out").GetBoolean(), Reporting.ReportsEnabled(setting, c.Str("env")));
    }

    [Theory]
    [MemberData(nameof(PingCases))]
    public void Ping(string name, string json)
    {
        _ = name;
        var c = JsonDocument.Parse(json).RootElement;
        var r = PingResponse.For(c.Str("challenge"), S.GetProperty("ping").Str("plugin")!, c.GetProperty("enabled").GetBoolean());
        Assert.Equal(c.GetProperty("status").GetInt32(), r.Status);
        AssertJson(JsonNode.Parse(c.GetProperty("body").GetRawText()), JsonNode.Parse(r.Body));
        Assert.Equal(new Dictionary<string, string> { ["Content-Type"] = "application/json", ["Cache-Control"] = "no-store" }, r.Headers);
    }

    [Theory]
    [MemberData(nameof(EndpointCases))]
    public void PingEndpoint(string name, string json)
    {
        _ = name;
        var c = JsonDocument.Parse(json).RootElement;
        var r = PingResponse.For(c.Str("challenge"), "Some-Supertext-Translation", enabled: true);
        Assert.Equal(c.GetProperty("status").GetInt32(), r.Status);
        var expected = JsonNode.Parse(c.GetProperty("body").GetRawText())!.AsObject();
        if (expected.ContainsKey("plugin"))
        {
            expected["plugin"] = "Some-Supertext-Translation";
        }
        AssertJson(expected, JsonNode.Parse(r.Body));
    }

    [Theory]
    [MemberData(nameof(ScenarioCases))]
    public async Task Scenario(string name, string json)
    {
        _ = name;
        var scenario = JsonDocument.Parse(json).RootElement;
        var config = Config();
        if (scenario.TryGetProperty("config", out var overrides))
        {
            foreach (var p in overrides.EnumerateObject())
            {
                config[p.Name] = JsonNode.Parse(p.Value.GetRawText());
            }
        }
        var state = ReporterState.FromJson(scenario.GetProperty("state"));
        foreach (var step in scenario.GetProperty("steps").EnumerateArray())
        {
            var action = step.Str("action")!;
            var calls = new List<string>();
            var stepChecks = step.TryGetProperty("keyChecks", out var ks)
                ? ks.EnumerateArray().Select(c => ReporterState.FromJson($$"""{"keyCheck":{{c.GetRawText()}}}""").KeyCheck!).ToList()
                : step.TryGetProperty("keyCheck", out var k) ? [ReporterState.FromJson($$"""{"keyCheck":{{k.GetRawText()}}}""").KeyCheck!] : [];
            var checker = FakeCheckers(stepChecks, calls);
            List<KeyValuePair<string, string>>? named = step.TryGetProperty("apiKeys", out var ak)
                ? ak.EnumerateObject().Select(p => new KeyValuePair<string, string>(p.Name, p.Value.GetString()!)).ToList()
                : null;
            var http = new FakeCenter(step.TryGetProperty("report", out var report) ? report : null, calls);
            var reporter = Reporter(config, http, new FixedTime(DateTimeOffset.Parse(step.Str("now")!)), checker);
            var apiKey = step.Str("apiKey");
            var r = action switch
            {
                "afterSettingsSaved" when named is not null => await reporter.AfterSettingsSavedAsync(state, named),
                "onRequest" when named is not null => await reporter.OnRequestAsync(state, named),
                "authenticationFailed" when named is not null => await reporter.AuthenticationFailedAsync(state, named, step.GetProperty("httpStatus").GetInt32(), step.Str("keyName")),
                "testConnection" when named is not null => await reporter.TestConnectionAsync(state, named),
                "afterSettingsSaved" => await reporter.AfterSettingsSavedAsync(state, apiKey),
                "onRequest" => await reporter.OnRequestAsync(state, apiKey),
                "authenticationFailed" => await reporter.AuthenticationFailedAsync(state, apiKey, step.GetProperty("httpStatus").GetInt32()),
                "testConnection" => await reporter.TestConnectionAsync(state, apiKey),
                "reportCheck" => await reporter.ReportCheckAsync(state),
                _ => throw new InvalidOperationException("unknown action " + action),
            };
            var expect = step.GetProperty("expect");
            Assert.Equal(expect.GetProperty("calls").EnumerateArray().Select(e => e.GetString()!), calls);
            Assert.Equal(expect.Str("event"), r.Event);
            Assert.Equal(expect.GetProperty("sent").GetBoolean(), r.Sent);
            var expectedState = ReporterState.FromJson(expect.GetProperty("state"));
            Assert.Equal(expectedState, r.State);
            Assert.Equal(ReporterState.FromJson($$"""{"keyCheck":{{expect.GetProperty("check").GetRawText()}}}""").KeyCheck, r.Check);
            Assert.Equal(
                ReporterState.FromJson($$"""{"keyChecks":{{expect.GetProperty("checks").GetRawText()}}}""").KeyChecks?.Select(c => c.ToString()),
                r.Checks?.Select(c => c.ToString()));
            // The stored form has exactly the spec's shape and survives a round trip.
            AssertJson(JsonNode.Parse(expect.GetProperty("state").GetRawText()), JsonNode.Parse(r.State.ToJson()));
            if (expect.TryGetProperty("reportBody", out var body))
            {
                AssertJson(JsonNode.Parse(body.GetRawText()), http.Bodies[0]);
            }
            foreach (var userAgent in http.UserAgents)
            {
                Assert.Equal($"supertext-plugin-health/{PluginHealthInfo.Version} (dotnet) {(string?)config["plugin"]!["name"]}/{(string?)config["plugin"]!["version"]}", userAgent);
            }
            state = ReporterState.FromJson(r.State.ToJson());
            Assert.Equal(expectedState, state);
        }
    }

    [Fact]
    public void BuildsReportsWithTheFieldsOfTheCenterSchema()
    {
        var schema = Spec.Center("report-v1.schema.json");
        var reporter = Reporter(Config(), new FakeCenter(null), TimeProvider.System, FakeChecker(null));
        var withCheck = ReporterState.Empty with { KeyCheck = new KeyCheck("invalid", "2026-10-13T08:00:00Z", 401, "bad_key", "fp") };
        foreach (var state in new[] { ReporterState.Empty, withCheck })
        {
            var body = reporter.BuildReport(ReportEvents.SettingsSaved, state);
            foreach (var field in schema.GetProperty("required").EnumerateArray())
            {
                Assert.True(body.ContainsKey(field.GetString()!), field.GetString());
            }
            foreach (var (field, _) in body)
            {
                Assert.True(schema.GetProperty("properties").TryGetProperty(field, out _), field);
            }
        }
    }

    [Fact]
    public async Task NeverSendsTheKeyOrItsFingerprint()
    {
        var calls = new List<string>();
        var check = new KeyCheck("ok", "2026-10-13T08:00:00Z", 200, null, "abc");
        var checker = KeyChecker.FromDelegates((_, _) => Task.FromResult(check), _ => "abc");
        var http = new FakeCenter(Answer("""{"status":202}"""), calls);
        var reporter = Reporter(Config(), http, TimeProvider.System, checker);
        var r = await reporter.AfterSettingsSavedAsync(null, "secret-key-123");
        Assert.True(r.Sent);
        var sent = string.Join("\n", http.Bodies.Select(b => b!.ToJsonString()));
        Assert.DoesNotContain("secret-key-123", sent);
        Assert.DoesNotContain("\"abc\"", sent);
        Assert.DoesNotContain("secret-key-123", r.State.ToJson());
    }

    [Fact]
    public async Task AThrowingCheckerGivesAnErrorCheck()
    {
        var checker = KeyChecker.FromDelegates((_, _) => throw new InvalidOperationException("boom"), _ => "fp");
        var config = Config();
        config["enabled"] = false;
        var reporter = Reporter(config, new FakeCenter(null), new FixedTime(DateTimeOffset.Parse("2026-10-13T08:00:00.700Z")), checker);
        var r = await reporter.AfterSettingsSavedAsync(null, "k");
        Assert.Equal(new KeyCheck("error", "2026-10-13T08:00:00Z", null, null, "fp"), r.Check);
    }

    [Fact]
    public async Task AFaultedOrNullCheckGivesAnErrorCheck()
    {
        var time = new FixedTime(DateTimeOffset.Parse("2026-10-13T08:00:00Z"));
        var faulted = KeyChecker.FromDelegates((_, _) => Task.FromException<KeyCheck>(new HttpRequestException("x")), _ => "fp");
        var nullCheck = KeyChecker.FromDelegates((_, _) => Task.FromResult<KeyCheck>(null!), _ => "fp");
        foreach (var checker in new[] { faulted, nullCheck })
        {
            var reporter = Reporter(Config(), new FakeCenter(Answer("""{"status":202}""")), time, checker);
            var r = await reporter.TestConnectionAsync(null, "k");
            Assert.Equal(new KeyCheck("error", "2026-10-13T08:00:00Z", null, null, "fp"), r.Check);
        }
    }

    [Fact]
    public void WithoutAnSdkVersionTheReportHasNoSdkVersion()
    {
        var config = Config();
        config["sdkVersion"] = null;
        var reporter = Reporter(config, new FakeCenter(null), TimeProvider.System, FakeChecker(null));
        Assert.False(reporter.BuildReport(ReportEvents.Check, ReporterState.Empty).ContainsKey("sdk_version"));
    }

    [Fact]
    public void TreatsABrokenStoredStateAsEmpty()
    {
        Assert.Equal(ReporterState.Empty, ReporterState.FromJson("not json"));
        Assert.Equal(ReporterState.Empty, ReporterState.FromJson((string?)null));
        Assert.Equal(ReporterState.Empty, ReporterState.FromJson("[1,2]"));
        Assert.Null(ReporterState.FromJson("""{"keyCheck":{"status":"ok"}}""").KeyCheck);
        Assert.Equal("""{"reportedVersions":null,"reportedKeyStatus":null,"lastFailureAt":null,"keyCheck":null,"keyChecks":null,"reportedKeyStatuses":null}""", ReporterState.Empty.ToJson());
    }

    [Fact]
    public void ReadsAStateStoredByTheSdkReporter()
    {
        const string old = """{"reportedVersions":"0.2.0|12.0.0|22.11.0","reportedKeyStatus":"ok","lastFailureAt":null,"keyCheck":{"status":"ok","checkedAt":"2026-10-13T08:00:00Z","httpStatus":200,"errorCode":null,"fingerprint":"abc"}}""";
        var state = ReporterState.FromJson(old);
        Assert.Equal(new ReporterState("0.2.0|12.0.0|22.11.0", "ok", null, new KeyCheck("ok", "2026-10-13T08:00:00Z", 200, null, "abc")), state);
        Assert.Equal(old[..^1] + ",\"keyChecks\":null,\"reportedKeyStatuses\":null}", state.ToJson());
    }

    [Fact]
    public async Task ChecksAtMostTwentyNamedKeys()
    {
        var calls = new List<string>();
        var ok = new KeyCheck("ok", "2026-10-13T08:00:00Z", 200, null, "fp");
        var http = new FakeCenter(Answer("""{"status":202}"""), calls);
        var reporter = Reporter(Config(), http, new FixedTime(DateTimeOffset.Parse("2026-10-13T08:00:00Z")), KeyChecker.FromDelegates((_, _) => Task.FromResult(ok), _ => "fp"));
        var keys = new List<KeyValuePair<string, string>> { new(" ", "x"), new("A ", "k1") };
        keys.AddRange(Enumerable.Range(0, 25).Select(n => new KeyValuePair<string, string>($"Key {n}", "k1")));
        keys.Add(new("A", "k2"));
        var r = await reporter.AfterSettingsSavedAsync(null, keys);
        Assert.Equal(20, r.Checks!.Count);
        Assert.Equal("A", r.Checks[0].Name);
        Assert.Equal(20, http.Bodies[0]!["api_keys"]!.AsArray().Count);
    }

    [Fact]
    public void DetectsTheRuntime()
    {
        var config = Config();
        config.Remove("runtime");
        var reporter = Reporter(config, new FakeCenter(null), TimeProvider.System, FakeChecker(null));
        AssertJson(new JsonObject { ["name"] = ".NET", ["version"] = Environment.Version.ToString() }, reporter.BuildReport(ReportEvents.Check, ReporterState.Empty)["runtime"]);
        Assert.EndsWith("|" + Environment.Version, reporter.Versions);
        Assert.True(reporter.Enabled);
    }

    [Fact]
    public async Task ACancelledCallerTokenIsNotSwallowed()
    {
        var checker = KeyChecker.FromDelegates((_, ct) => Task.FromCanceled<KeyCheck>(ct), _ => "fp");
        var reporter = Reporter(Config(), new FakeCenter(Answer("""{"status":202}""")), TimeProvider.System, checker);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reporter.AfterSettingsSavedAsync(null, "k1", cts.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reporter.ReportCheckAsync(null, cts.Token));
    }

    [Fact]
    public void HasOneNamespaceAndNoDependencies()
    {
        var assembly = typeof(InstallationReporter).Assembly;
        Assert.All(assembly.GetExportedTypes(), t => Assert.Equal("Supertext.PluginHealth", t.Namespace));
        Assert.All(assembly.GetReferencedAssemblies(), a => Assert.True(a.Name!.StartsWith("System", StringComparison.Ordinal) || a.Name == "netstandard" || a.Name == "mscorlib", a.Name));
        Assert.Null(assembly.GetCustomAttribute<System.Runtime.CompilerServices.InternalsVisibleToAttribute>());
    }

    private static JsonObject Config() => JsonNode.Parse(S.GetProperty("config").GetRawText())!.AsObject();

    private static InstallationReporter Reporter(JsonObject config, FakeCenter http, TimeProvider clock, IKeyChecker checker, string? reportUrl = ReportUrl)
    {
        static NameVersion Nv(JsonNode? n) => new((string)n!["name"]!, (string?)n["version"]);
        return new InstallationReporter(new ReporterOptions
        {
            Enabled = (bool)config["enabled"]!,
            SiteUrl = (string)config["siteUrl"]!,
            CallbackUrl = (string?)config["callbackUrl"],
            Plugin = Nv(config["plugin"]),
            System = Nv(config["system"]),
            Runtime = config["runtime"] is { } runtime ? Nv(runtime) : null,
            SdkVersion = (string?)config["sdkVersion"],
            KeyChecker = checker,
            ReportUrl = reportUrl,
            HttpClient = new HttpClient(http),
            TimeProvider = clock,
        });
    }

    /// <summary>Fake key checker: returns the step's keyCheck, fingerprints from the spec's table, records "keyCheck".</summary>
    private static IKeyChecker FakeChecker(KeyCheck? stepCheck, List<string>? calls = null) =>
        FakeCheckers(stepCheck is null ? [] : [stepCheck], calls, repeat: true);

    /// <summary>Fake key checker returning the given checks one per call (the last one again with <paramref name="repeat"/>).</summary>
    private static IKeyChecker FakeCheckers(List<KeyCheck> stepChecks, List<string>? calls = null, bool repeat = false)
    {
        var fingerprints = S.GetProperty("fingerprints");
        var queue = new Queue<KeyCheck>(stepChecks);
        return KeyChecker.FromDelegates(
            (_, _) =>
            {
                calls?.Add("keyCheck");
                if (queue.Count == 0)
                {
                    throw new InvalidOperationException("unexpected key check");
                }
                return Task.FromResult(repeat && queue.Count == 1 ? queue.Peek() : queue.Dequeue());
            },
            apiKey => fingerprints.TryGetProperty(apiKey ?? string.Empty, out var fp)
                ? fp.GetString()!
                : throw new InvalidOperationException($"no fingerprint for \"{apiKey}\""));
    }

    private static JsonElement Answer(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static void AssertJson(JsonNode? expected, JsonNode? actual) =>
        Assert.True(JsonNode.DeepEquals(expected, actual), $"expected {expected?.ToJsonString()}, got {actual?.ToJsonString()}");

    /// <summary>A fixed clock.</summary>
    private sealed class FixedTime(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    /// <summary>Fake center: answers POST report with the step's status or a transport error, records "report".</summary>
    private sealed class FakeCenter(JsonElement? report, List<string>? calls = null) : HttpMessageHandler
    {
        public List<JsonNode?> Bodies { get; } = [];

        public List<string> UserAgents { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            calls?.Add("report");
            Assert.Equal(ReportUrl, request.RequestUri!.ToString());
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal("application/json", request.Content!.Headers.ContentType!.MediaType);
            Assert.Equal("application/json", string.Join(",", request.Headers.GetValues("Accept")));
            Bodies.Add(JsonNode.Parse(await request.Content.ReadAsStringAsync(cancellationToken)));
            UserAgents.Add(string.Join(" ", request.Headers.GetValues("User-Agent")));
            if (report is not { ValueKind: JsonValueKind.Object } a)
            {
                throw new InvalidOperationException("unexpected report");
            }
            if (a.TryGetProperty("transportError", out var t) && t.GetBoolean())
            {
                throw new HttpRequestException("connection refused");
            }
            var status = a.TryGetProperty("status", out var s) ? s.GetInt32() : 202;
            return new HttpResponseMessage((HttpStatusCode)status);
        }
    }
}
