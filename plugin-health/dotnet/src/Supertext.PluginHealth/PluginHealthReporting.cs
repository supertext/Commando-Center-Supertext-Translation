using System.Globalization;
using System.Text.RegularExpressions;

namespace Supertext.PluginHealth;

/// <summary>
/// Version reports to the Supertext Plugin Health dashboard, the API key check result and the callback ping
/// (plugin-health/spec/reporter.json). See <see cref="InstallationReporter"/> and <see cref="PingResponse"/>.
/// </summary>
public static partial class Reporting
{
    /// <summary>The live Plugin Health dashboard. <c>SUPERTEXT_REPORT_URL</c> in the environment overrides it.</summary>
    public const string DefaultReportUrl = "https://commandocenter-production.up.railway.app/api/v1/report";

    /// <summary>Timeout of a report.</summary>
    public static readonly TimeSpan ReportTimeout = TimeSpan.FromSeconds(3);

    /// <summary>No new report within this time after a failed one (except <see cref="InstallationReporter.ReportCheckAsync"/>).</summary>
    public static readonly TimeSpan FailureBackoff = TimeSpan.FromSeconds(3600);

    /// <summary>
    /// Whether version reports are on: <c>SUPERTEXT_VERSION_REPORTS</c> from the environment
    /// (0/false/off/no, 1/true/on/yes) wins over the setting; the setting defaults to on.
    /// </summary>
    /// <param name="setting">The "Send version information to Supertext" setting; null if not set.</param>
    public static bool ReportsEnabled(bool? setting) =>
        ReportsEnabled(setting, Environment.GetEnvironmentVariable("SUPERTEXT_VERSION_REPORTS"));

    /// <summary>Like <see cref="ReportsEnabled(bool?)"/>, with the environment value passed in.</summary>
    public static bool ReportsEnabled(bool? setting, string? env)
    {
        switch ((env ?? string.Empty).Trim().ToLowerInvariant())
        {
            case "0" or "false" or "off" or "no":
                return false;
            case "1" or "true" or "on" or "yes":
                return true;
            default:
                return setting ?? true;
        }
    }

    /// <summary>UTC ISO 8601 without fractions, e.g. <c>2026-10-13T08:00:00Z</c>.</summary>
    public static string IsoSeconds(DateTimeOffset time) =>
        time.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    [GeneratedRegex(@"^[A-Za-z0-9_-]{16,64}\z")]
    internal static partial Regex Challenge();
}

/// <summary>The events of a report (<see cref="ReporterResult.Event"/>).</summary>
public static class ReportEvents
{
    /// <summary>First report of this installation.</summary>
    public const string Installed = "installed";

    /// <summary>The plugin's settings were saved.</summary>
    public const string SettingsSaved = "settings_saved";

    /// <summary>The plugin, system or runtime version changed.</summary>
    public const string Upgraded = "upgraded";

    /// <summary>The API key's status changed.</summary>
    public const string ApiKeyCheck = "api_key_check";

    /// <summary>Sent on request (<see cref="InstallationReporter.ReportCheckAsync"/>).</summary>
    public const string Check = "check";
}

/// <summary>A name and an optional version (system, runtime, plugin).</summary>
public sealed record NameVersion(string Name, string? Version = null);
