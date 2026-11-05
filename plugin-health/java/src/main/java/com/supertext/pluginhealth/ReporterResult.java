package com.supertext.pluginhealth;

/** What an {@link InstallationReporter} call did. Immutable. */
public final class ReporterResult {

    private final ReporterState state;
    private final ReportEvent event;
    private final boolean sent;

    ReporterResult(ReporterState state, ReportEvent event, boolean sent) {
        this.state = state;
        this.event = event;
        this.sent = sent;
    }

    /** Store this ({@link ReporterState#toJson()}). */
    public ReporterState getState() {
        return state;
    }

    /** The latest key check (show it on the settings or status page); {@code null} if none ran yet. */
    public KeyCheck getCheck() {
        return state.getKeyCheck();
    }

    /** The event that was reported (or tried); {@code null} when nothing was due. */
    public ReportEvent getEvent() {
        return event;
    }

    /** Whether the Plugin Health dashboard accepted the report (2xx). */
    public boolean isSent() {
        return sent;
    }

    @Override
    public String toString() {
        return "ReporterResult{event=" + (event == null ? null : event.value()) + ", sent=" + sent + ", state=" + state + "}";
    }
}
