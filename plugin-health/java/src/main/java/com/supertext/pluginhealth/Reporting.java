package com.supertext.pluginhealth;

import java.time.Duration;
import java.util.Locale;

/** Defaults and the on/off switch for version reports (plugin-health/spec/reporter.json). */
public final class Reporting {

    /** The live Supertext Plugin Health dashboard. */
    public static final String DEFAULT_REPORT_URL = "https://commandocenter-production.up.railway.app/api/v1/report";

    /** Timeout of a report. */
    public static final Duration REPORT_TIMEOUT = Duration.ofSeconds(3);

    /** After a failed report, no new attempt for this long (except {@link InstallationReporter#reportCheck}). */
    public static final Duration FAILURE_BACKOFF = Duration.ofSeconds(3600);

    /** Environment variable that turns reports on or off, whatever the setting says. */
    public static final String ENV_VERSION_REPORTS = "SUPERTEXT_VERSION_REPORTS";

    /** Environment variable with another report URL (tests, staging). */
    public static final String ENV_REPORT_URL = "SUPERTEXT_REPORT_URL";

    private Reporting() {
    }

    /** {@link #reportsEnabled(Boolean, String)} with {@code SUPERTEXT_VERSION_REPORTS} from the environment. */
    public static boolean reportsEnabled(Boolean setting) {
        return reportsEnabled(setting, System.getenv(ENV_VERSION_REPORTS));
    }

    /**
     * Whether version reports are on: the environment value ({@code 0/false/off/no} or
     * {@code 1/true/on/yes}, any case, trimmed) wins over the setting; an unset setting means on.
     *
     * @param setting the "Send version information to Supertext" setting, or {@code null} when not set
     * @param env     the value of {@code SUPERTEXT_VERSION_REPORTS}, or {@code null}
     */
    public static boolean reportsEnabled(Boolean setting, String env) {
        String value = env == null ? "" : env.trim().toLowerCase(Locale.ROOT);
        switch (value) {
            case "0": case "false": case "off": case "no":
                return false;
            case "1": case "true": case "on": case "yes":
                return true;
            default:
                return setting == null || setting;
        }
    }
}
