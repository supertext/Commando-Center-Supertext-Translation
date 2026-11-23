package com.supertext.pluginhealth;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * What a plugin stores between requests for the {@link InstallationReporter}: store {@link #toJson()}
 * as it is and load it with {@link #fromJson(String)}. Immutable.
 *
 * <p>JSON shape (plugin-health/spec/reporter.json): {@code {"reportedVersions":…,"reportedKeyStatus":…,"lastFailureAt":…,
 * "keyCheck":{"status","checkedAt","httpStatus","errorCode","fingerprint"},"keyChecks":{name:{…}},
 * "reportedKeyStatuses":{name:status}}}. The first four fields are the state the Supertext SDK 0.1–0.2 reporter
 * stored, so a plugin that switches keeps its history; keyChecks and reportedKeyStatuses are for plugins with
 * several named keys (null with one key).</p>
 */
public final class ReporterState {

    /** Nothing reported, no check yet. */
    public static final ReporterState EMPTY = new ReporterState(null, null, null, null);

    private final String reportedVersions;
    private final String reportedKeyStatus;
    private final String lastFailureAt;
    private final KeyCheck keyCheck;
    private final Map<String, KeyCheck> keyChecks;
    private final Map<String, String> reportedKeyStatuses;

    /**
     * @param reportedVersions  {@code <plugin>|<system>|<runtime>} versions last reported successfully
     * @param reportedKeyStatus the key status last reported successfully
     * @param lastFailureAt     when the last report failed (no new attempt for an hour)
     * @param keyCheck          the latest key check
     */
    public ReporterState(String reportedVersions, String reportedKeyStatus, String lastFailureAt, KeyCheck keyCheck) {
        this(reportedVersions, reportedKeyStatus, lastFailureAt, keyCheck, null, null);
    }

    /**
     * @param keyChecks           several keys: the latest check per name, in the plugin's order; {@code null} with one key
     * @param reportedKeyStatuses several keys: the statuses last reported successfully, by name
     */
    public ReporterState(String reportedVersions, String reportedKeyStatus, String lastFailureAt, KeyCheck keyCheck,
            Map<String, KeyCheck> keyChecks, Map<String, String> reportedKeyStatuses) {
        this.reportedVersions = reportedVersions;
        this.reportedKeyStatus = reportedKeyStatus;
        this.lastFailureAt = lastFailureAt;
        this.keyCheck = keyCheck;
        this.keyChecks = keyChecks == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(keyChecks));
        this.reportedKeyStatuses = reportedKeyStatuses == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(reportedKeyStatuses));
    }

    /** A stored state; {@code null}, broken JSON or unknown values become {@link #EMPTY} (or empty fields). */
    public static ReporterState fromJson(String json) {
        if (json == null) {
            return EMPTY;
        }
        Object value;
        try {
            value = Json.parse(json);
        } catch (IllegalArgumentException e) {
            return EMPTY;
        }
        if (!(value instanceof Map)) {
            return EMPTY;
        }
        Map<?, ?> map = (Map<?, ?>) value;
        Map<String, KeyCheck> keyChecks = null;
        if (map.get("keyChecks") instanceof Map) {
            keyChecks = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) map.get("keyChecks")).entrySet()) {
                KeyCheck c = KeyCheck.fromMap(e.getValue());
                if (c != null) {
                    keyChecks.put(String.valueOf(e.getKey()), c);
                }
            }
        }
        Map<String, String> reported = null;
        if (map.get("reportedKeyStatuses") instanceof Map) {
            reported = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) map.get("reportedKeyStatuses")).entrySet()) {
                if (e.getValue() instanceof String) {
                    reported.put(String.valueOf(e.getKey()), (String) e.getValue());
                }
            }
        }
        return new ReporterState(string(map.get("reportedVersions")), string(map.get("reportedKeyStatus")),
                string(map.get("lastFailureAt")), KeyCheck.fromMap(map.get("keyCheck")), keyChecks, reported);
    }

    /** The form to store (compact JSON, every field present). */
    public String toJson() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("reportedVersions", reportedVersions);
        map.put("reportedKeyStatus", reportedKeyStatus);
        map.put("lastFailureAt", lastFailureAt);
        map.put("keyCheck", keyCheck == null ? null : keyCheck.toMap());
        if (keyChecks == null) {
            map.put("keyChecks", null);
        } else {
            Map<String, Object> checks = new LinkedHashMap<>();
            keyChecks.forEach((name, check) -> checks.put(name, check.toMap()));
            map.put("keyChecks", checks);
        }
        map.put("reportedKeyStatuses", reportedKeyStatuses == null ? null : new LinkedHashMap<>(reportedKeyStatuses));
        return Json.write(map);
    }

    public String getReportedVersions() {
        return reportedVersions;
    }

    public String getReportedKeyStatus() {
        return reportedKeyStatus;
    }

    public String getLastFailureAt() {
        return lastFailureAt;
    }

    /** The latest key check, or {@code null}. */
    public KeyCheck getKeyCheck() {
        return keyCheck;
    }

    /** Several keys: the latest check per name, in the plugin's order; {@code null} with one key. */
    public Map<String, KeyCheck> getKeyChecks() {
        return keyChecks;
    }

    /** Several keys: the statuses last reported successfully, by name; {@code null} with one key. */
    public Map<String, String> getReportedKeyStatuses() {
        return reportedKeyStatuses;
    }

    /** A copy with another key check (one key). */
    public ReporterState withKeyCheck(KeyCheck check) {
        return new ReporterState(reportedVersions, reportedKeyStatus, lastFailureAt, check, keyChecks, reportedKeyStatuses);
    }

    private static String string(Object value) {
        return value instanceof String ? (String) value : null;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof ReporterState)) {
            return false;
        }
        ReporterState other = (ReporterState) o;
        return Objects.equals(reportedVersions, other.reportedVersions) && Objects.equals(reportedKeyStatus, other.reportedKeyStatus)
                && Objects.equals(lastFailureAt, other.lastFailureAt) && Objects.equals(keyCheck, other.keyCheck)
                && Objects.equals(keyChecks == null ? null : new java.util.ArrayList<>(keyChecks.entrySet()),
                        other.keyChecks == null ? null : new java.util.ArrayList<>(other.keyChecks.entrySet()))
                && Objects.equals(reportedKeyStatuses, other.reportedKeyStatuses);
    }

    @Override
    public int hashCode() {
        return Objects.hash(reportedVersions, reportedKeyStatus, lastFailureAt, keyCheck, keyChecks, reportedKeyStatuses);
    }

    @Override
    public String toString() {
        return "ReporterState{reportedVersions=" + reportedVersions + ", reportedKeyStatus=" + reportedKeyStatus
                + ", lastFailureAt=" + lastFailureAt + ", keyCheck=" + keyCheck + ", keyChecks=" + keyChecks
                + ", reportedKeyStatuses=" + reportedKeyStatuses + "}";
    }
}
