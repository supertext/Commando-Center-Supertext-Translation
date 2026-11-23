using System.Text.Json;

namespace Supertext.PluginHealth.Tests;

/// <summary>
/// Loads the shared vectors: plugin-health/spec/ (reporter.json), the center's spec/ (callback-vectors.json,
/// report-v1.schema.json) and the TypeScript package.json, found by walking up from the test assembly.
/// </summary>
internal static class Spec
{
    /// <summary>The plugin-health/ folder.</summary>
    private static readonly Lazy<string> PluginHealthDir = new(() =>
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "spec", "reporter.json")))
            {
                return dir.FullName;
            }
        }
        throw new InvalidOperationException("plugin-health/spec/reporter.json not found above " + AppContext.BaseDirectory);
    });

    /// <summary>plugin-health/spec/&lt;name&gt;.</summary>
    public static JsonElement Load(string name) => Read(Path.Combine(PluginHealthDir.Value, "spec", name));

    /// <summary>The Plugin Health dashboard's spec/&lt;name&gt; (next to plugin-health/).</summary>
    public static JsonElement Center(string name) => Read(Path.Combine(PluginHealthDir.Value, "..", "spec", name));

    /// <summary>plugin-health/typescript/package.json.</summary>
    public static JsonElement TypeScriptPackage() => Read(Path.Combine(PluginHealthDir.Value, "typescript", "package.json"));

    /// <summary>Cases as xUnit rows: (name, case as JSON text), so test explorers show them separately.</summary>
    public static IEnumerable<object[]> Cases(JsonElement array, string prefix, string? nameProperty = null)
    {
        var i = 0;
        foreach (var item in array.EnumerateArray())
        {
            var name = nameProperty is not null && item.TryGetProperty(nameProperty, out var n) ? n.GetString()! : $"{prefix}[{i}]";
            i++;
            yield return [name, item.GetRawText()];
        }
    }

    public static string? Str(this JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static JsonElement Read(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return doc.RootElement.Clone();
    }
}
