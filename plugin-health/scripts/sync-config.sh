#!/usr/bin/env bash
# plugin-health/config.json is the only place the default report URL is written. Each language
# reads a copy that ships with its sources (so a plugin's bundled copy has it too):
#   typescript/src/config.json, php/src/config.json, python/src/supertext_plugin_health/config.json,
#   dotnet/src/Supertext.PluginHealth/config.json (embedded resource),
#   java/src/main/resources/com/supertext/pluginhealth/config.json (classpath resource).
# Without arguments: copies config.json there. With --check: fails if a copy differs (CI).
set -euo pipefail
cd "$(dirname "$0")/.."
copies=(
  typescript/src/config.json
  php/src/config.json
  python/src/supertext_plugin_health/config.json
  dotnet/src/Supertext.PluginHealth/config.json
  java/src/main/resources/com/supertext/pluginhealth/config.json
)
url="$(sed -n 's/.*"reportUrl": *"\([^"]*\)".*/\1/p' config.json)"
spec="$(sed -n '/"defaults"/,/}/s/.*"reportUrl": *"\([^"]*\)".*/\1/p' spec/reporter.json)"
status=0
if [ "$url" != "$spec" ]; then
  echo "::error file=plugin-health/spec/reporter.json::defaults.reportUrl '$spec' differs from config.json '$url'"
  status=1
fi
for f in "${copies[@]}"; do
  if [ "${1:-}" = "--check" ]; then
    cmp -s config.json "$f" || { echo "::error file=plugin-health/$f::differs from plugin-health/config.json (run plugin-health/scripts/sync-config.sh)"; status=1; }
  else
    mkdir -p "$(dirname "$f")"
    cp config.json "$f"
  fi
done
exit $status
