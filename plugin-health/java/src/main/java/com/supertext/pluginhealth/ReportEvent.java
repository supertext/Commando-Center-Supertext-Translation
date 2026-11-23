package com.supertext.pluginhealth;

/** The event of a version report. {@link #value()} is the string the Plugin Health dashboard expects. */
public enum ReportEvent {
    /** First report of this installation. */
    INSTALLED("installed"),
    /** The plugin's settings were saved. */
    SETTINGS_SAVED("settings_saved"),
    /** The plugin, system or runtime version changed. */
    UPGRADED("upgraded"),
    /** The API key's status changed. */
    API_KEY_CHECK("api_key_check"),
    /** Sent on demand ({@link InstallationReporter#reportCheck(ReporterState)}). */
    CHECK("check"),
    /** The list of installed plugins was sent ({@link InstallationReporter#sendExtensions}). */
    EXTENSIONS("extensions"),
    /** The language mapping was sent ({@link InstallationReporter#sendLanguages}). */
    LANGUAGES("languages");

    private final String value;

    ReportEvent(String value) {
        this.value = value;
    }

    /** {@code installed}, {@code settings_saved}, {@code upgraded}, {@code api_key_check}, {@code check}, {@code extensions} or {@code languages}. */
    public String value() {
        return value;
    }
}
