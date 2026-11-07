<?php

declare(strict_types=1);

namespace Supertext\PluginHealth;

/**
 * Supertext Plugin Health: version reports to the Supertext Plugin Health dashboard, the API key check result
 * and the plugin's ping endpoint (../spec/reporter.json; protocol: the dashboard's
 * docs/DEVELOPER.md → Report protocol).
 */
final class PluginHealth
{
    /** The library's version, the same in all five languages (plugin-health/CHANGELOG.md). */
    public const PLUGIN_HEALTH_VERSION = '0.2.0';

    private function __construct()
    {
    }
}
