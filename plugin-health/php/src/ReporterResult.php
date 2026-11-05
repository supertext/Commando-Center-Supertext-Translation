<?php

declare(strict_types=1);

namespace Supertext\PluginHealth;

/**
 * What an InstallationReporter call did.
 */
final class ReporterResult
{
    /**
     * @param ReporterState $state the new state: store it
     * @param KeyCheck|null $check the latest key check (show it on the settings or status page)
     * @param string|null   $event the event that was reported (or tried); null when nothing was due
     * @param bool          $sent  whether the Plugin Health dashboard accepted the report
     */
    public function __construct(
        public readonly ReporterState $state,
        public readonly ?KeyCheck $check,
        public readonly ?string $event,
        public readonly bool $sent,
    ) {
    }
}
