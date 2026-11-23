using System.Collections.ObjectModel;
using System.Text.Json.Nodes;

namespace Supertext.PluginHealth;

/// <summary>
/// The answer of the plugin's public ping endpoint (<c>GET &lt;callback&gt;?challenge=&lt;c&gt;</c>), which the
/// Plugin Health dashboard calls to confirm a reported callback URL. Answer with it as it is (GET, no login, not cached).
/// </summary>
/// <param name="Status">200, 400 (bad or missing challenge) or 404 (reporting off).</param>
/// <param name="Headers"><c>Content-Type: application/json</c> and <c>Cache-Control: no-store</c>.</param>
/// <param name="Body">The JSON body.</param>
public sealed record PingResponse(int Status, IReadOnlyDictionary<string, string> Headers, string Body)
{
    /// <summary>
    /// The answer for a request's <c>challenge</c> parameter. Only while reporting is on (else 404); the
    /// challenge is echoed only if it matches <c>^[A-Za-z0-9_-]{16,64}$</c>.
    /// </summary>
    /// <param name="challenge">The <c>challenge</c> query parameter; null if missing.</param>
    /// <param name="plugin">The plugin's GitHub repository name.</param>
    /// <param name="enabled">Whether version reporting is on (<see cref="InstallationReporter.Enabled"/>).</param>
    public static PingResponse For(string? challenge, string plugin, bool enabled)
    {
        var headers = new ReadOnlyDictionary<string, string>(new Dictionary<string, string>
        {
            ["Content-Type"] = "application/json",
            ["Cache-Control"] = "no-store",
        });
        if (!enabled)
        {
            return new PingResponse(404, headers, """{"ok":false}""");
        }
        if (challenge is null || !Reporting.Challenge().IsMatch(challenge))
        {
            return new PingResponse(400, headers, """{"ok":false}""");
        }
        var body = new JsonObject { ["ok"] = true, ["plugin"] = plugin, ["challenge"] = challenge };
        return new PingResponse(200, headers, body.ToJsonString());
    }
}
