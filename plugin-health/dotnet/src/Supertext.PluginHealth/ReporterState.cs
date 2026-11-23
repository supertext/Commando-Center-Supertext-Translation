using System.Text;
using System.Text.Json;

namespace Supertext.PluginHealth;

/// <summary>
/// What the plugin stores between requests. Store <see cref="ToJson"/> as it is and load it with
/// <see cref="FromJson(string?)"/>. The same JSON in every language (the Supertext SDK 0.1–0.2 reporter
/// stored the first four fields). <see cref="KeyChecks"/> and <see cref="ReportedKeyStatuses"/> are for plugins
/// with several named keys; with one key they are null.
/// </summary>
/// <param name="ReportedVersions"><c>&lt;plugin&gt;|&lt;system&gt;|&lt;runtime&gt;</c> versions last reported successfully.</param>
/// <param name="ReportedKeyStatus">The key status last reported successfully.</param>
/// <param name="LastFailureAt">When the last report failed (no new attempt for an hour).</param>
/// <param name="KeyCheck">The latest key check.</param>
public sealed record ReporterState(string? ReportedVersions, string? ReportedKeyStatus, string? LastFailureAt, KeyCheck? KeyCheck)
{
    /// <summary>Nothing reported, nothing checked.</summary>
    public static ReporterState Empty { get; } = new(null, null, null, null);

    /// <summary>Several keys: the latest check per name, in the plugin's order; null with one key.</summary>
    public IReadOnlyList<NamedKeyCheck>? KeyChecks { get; init; }

    /// <summary>Several keys: the statuses last reported successfully, by name.</summary>
    public IReadOnlyDictionary<string, string>? ReportedKeyStatuses { get; init; }

    /// <summary>Equal when all fields are (the lists and maps by content).</summary>
    public bool Equals(ReporterState? other) => other is not null && ToJson() == other.ToJson();

    /// <inheritdoc/>
    public override int GetHashCode() => ToJson().GetHashCode(StringComparison.Ordinal);

    /// <summary>The state as JSON: <c>{"reportedVersions":…,"reportedKeyStatus":…,"lastFailureAt":…,"keyCheck":{…}|null}</c>.</summary>
    public string ToJson()
    {
        using var stream = new MemoryStream();
        using (var w = new Utf8JsonWriter(stream))
        {
            w.WriteStartObject();
            WriteString(w, "reportedVersions", ReportedVersions);
            WriteString(w, "reportedKeyStatus", ReportedKeyStatus);
            WriteString(w, "lastFailureAt", LastFailureAt);
            if (KeyCheck is { } k)
            {
                w.WritePropertyName("keyCheck");
                WriteCheck(w, k);
            }
            else
            {
                w.WriteNull("keyCheck");
            }
            if (KeyChecks is { } checks)
            {
                w.WriteStartObject("keyChecks");
                foreach (var named in checks)
                {
                    w.WritePropertyName(named.Name);
                    WriteCheck(w, named.Check);
                }
                w.WriteEndObject();
            }
            else
            {
                w.WriteNull("keyChecks");
            }
            if (ReportedKeyStatuses is { } reported)
            {
                w.WriteStartObject("reportedKeyStatuses");
                foreach (var (name, status) in reported)
                {
                    w.WriteString(name, status);
                }
                w.WriteEndObject();
            }
            else
            {
                w.WriteNull("reportedKeyStatuses");
            }
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    /// <summary>A stored state; null, broken JSON or unknown values give an empty state (or fields).</summary>
    public static ReporterState FromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return Empty;
        }
        try
        {
            using var doc = JsonDocument.Parse(json);
            return FromJson(doc.RootElement);
        }
        catch (JsonException)
        {
            return Empty;
        }
    }

    /// <summary>A stored state from parsed JSON; anything but an object gives an empty state.</summary>
    public static ReporterState FromJson(JsonElement json)
    {
        if (json.ValueKind != JsonValueKind.Object)
        {
            return Empty;
        }
        var keyCheck = json.TryGetProperty("keyCheck", out var k) ? Check(k) : null;
        List<NamedKeyCheck>? keyChecks = null;
        if (json.TryGetProperty("keyChecks", out var kc) && kc.ValueKind == JsonValueKind.Object)
        {
            keyChecks = [];
            foreach (var p in kc.EnumerateObject())
            {
                if (Check(p.Value) is { } c && keyChecks.TrueForAll(x => x.Name != p.Name))
                {
                    keyChecks.Add(new NamedKeyCheck(p.Name, c));
                }
            }
        }
        Dictionary<string, string>? reported = null;
        if (json.TryGetProperty("reportedKeyStatuses", out var rk) && rk.ValueKind == JsonValueKind.Object)
        {
            reported = new Dictionary<string, string>();
            foreach (var p in rk.EnumerateObject())
            {
                if (p.Value.ValueKind == JsonValueKind.String)
                {
                    reported[p.Name] = p.Value.GetString()!;
                }
            }
        }
        return new ReporterState(Str(json, "reportedVersions"), Str(json, "reportedKeyStatus"), Str(json, "lastFailureAt"), keyCheck)
        {
            KeyChecks = keyChecks,
            ReportedKeyStatuses = reported,
        };
    }

    private static KeyCheck? Check(JsonElement k)
    {
        if (k.ValueKind != JsonValueKind.Object || Str(k, "status") is not { } status || Str(k, "checkedAt") is not { } checkedAt)
        {
            return null;
        }
        int? httpStatus = k.TryGetProperty("httpStatus", out var h) && h.ValueKind == JsonValueKind.Number && h.TryGetInt32(out var n) ? n : null;
        return new KeyCheck(status, checkedAt, httpStatus, Str(k, "errorCode"), Str(k, "fingerprint") ?? string.Empty);
    }

    private static void WriteCheck(Utf8JsonWriter w, KeyCheck k)
    {
        w.WriteStartObject();
        w.WriteString("status", k.Status);
        w.WriteString("checkedAt", k.CheckedAt);
        if (k.HttpStatus is { } httpStatus)
        {
            w.WriteNumber("httpStatus", httpStatus);
        }
        else
        {
            w.WriteNull("httpStatus");
        }
        WriteString(w, "errorCode", k.ErrorCode);
        w.WriteString("fingerprint", k.Fingerprint);
        w.WriteEndObject();
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static void WriteString(Utf8JsonWriter w, string name, string? value)
    {
        if (value is null)
        {
            w.WriteNull(name);
        }
        else
        {
            w.WriteString(name, value);
        }
    }
}

/// <summary>The latest check of one of several named keys.</summary>
/// <param name="Name">What the key is for, as the plugin's settings call it (e.g. "AI translation").</param>
/// <param name="Check">Its latest check.</param>
public sealed record NamedKeyCheck(string Name, KeyCheck Check);
