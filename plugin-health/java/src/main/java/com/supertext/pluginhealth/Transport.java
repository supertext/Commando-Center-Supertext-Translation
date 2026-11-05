package com.supertext.pluginhealth;

import java.io.IOException;
import java.net.URI;
import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Sends the report to the Plugin Health dashboard. The default is {@link JdkHttpTransport}
 * ({@code java.net.http.HttpClient}); replace it in tests, or to route requests through your platform's HTTP stack.
 *
 * <p>Return the HTTP status of every answer; throw {@link IOException} only when there is no answer
 * (DNS, TLS, connection refused, timeout).</p>
 */
@FunctionalInterface
public interface Transport {

    /** Sends the request and returns the answer's HTTP status. */
    int send(Request request) throws IOException, InterruptedException;

    /** An HTTP request. */
    final class Request {
        private final String method;
        private final URI uri;
        private final Map<String, String> headers;
        private final byte[] body;
        private final Duration timeout;

        public Request(String method, URI uri, Map<String, String> headers, byte[] body, Duration timeout) {
            this.method = method;
            this.uri = uri;
            this.headers = Collections.unmodifiableMap(new LinkedHashMap<>(headers));
            this.body = body == null ? null : body.clone();
            this.timeout = timeout;
        }

        public String getMethod() {
            return method;
        }

        public URI getUri() {
            return uri;
        }

        /** Request headers in the order they were added. */
        public Map<String, String> getHeaders() {
            return headers;
        }

        /** The body, or {@code null} for none. */
        public byte[] getBody() {
            return body == null ? null : body.clone();
        }

        /** How long to wait for the answer. */
        public Duration getTimeout() {
            return timeout;
        }
    }
}
