package com.supertext.pluginhealth;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The answer of the plugin's public ping endpoint ({@code GET <callback>?challenge=<c>}), which the
 * Plugin Health dashboard calls to confirm a reported installation. Answers only while version reporting is
 * on (else 404); nothing a caller sends is echoed unless it matches {@code ^[A-Za-z0-9_-]{16,64}$}.
 * Answer with {@link #getStatus()}, {@link #getHeaders()} and {@link #getBody()} as they are.
 */
public final class PingResponse {

    private static final Pattern CHALLENGE = Pattern.compile("[A-Za-z0-9_-]{16,64}");
    private static final Map<String, String> HEADERS;

    static {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/json");
        headers.put("Cache-Control", "no-store");
        HEADERS = Collections.unmodifiableMap(headers);
    }

    private final int status;
    private final String body;

    private PingResponse(int status, String body) {
        this.status = status;
        this.body = body;
    }

    /**
     * @param challenge the {@code challenge} query parameter, or {@code null}
     * @param plugin    the plugin's GitHub repository name, e.g. {@code Magnolia-Supertext-Translation}
     * @param enabled   whether version reporting is on ({@link InstallationReporter#enabled()})
     */
    public static PingResponse forChallenge(String challenge, String plugin, boolean enabled) {
        if (!enabled) {
            return new PingResponse(404, "{\"ok\":false}");
        }
        if (challenge == null || !CHALLENGE.matcher(challenge).matches()) {
            return new PingResponse(400, "{\"ok\":false}");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", Boolean.TRUE);
        body.put("plugin", plugin);
        body.put("challenge", challenge);
        return new PingResponse(200, Json.write(body));
    }

    /** 200, 400 or 404. */
    public int getStatus() {
        return status;
    }

    /** {@code Content-Type: application/json} and {@code Cache-Control: no-store}, on every answer. */
    public Map<String, String> getHeaders() {
        return HEADERS;
    }

    /** The JSON body. */
    public String getBody() {
        return body;
    }
}
