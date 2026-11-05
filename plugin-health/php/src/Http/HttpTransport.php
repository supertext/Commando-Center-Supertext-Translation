<?php

declare(strict_types=1);

namespace Supertext\PluginHealth\Http;

/**
 * Sends the report to the Plugin Health dashboard. Implement it to use your framework's HTTP client
 * (Guzzle, Symfony HttpClient, a CMS's own) or a fake in tests.
 *
 * Return every HTTP answer, including 4xx and 5xx, as an HttpResponse. Throw (any exception) only when
 * there is no answer at all: DNS, TLS, connection refused, timeout. The reporter records either as a
 * failed report; nothing reaches the plugin's user.
 */
interface HttpTransport
{
    public function send(HttpRequest $request): HttpResponse;
}
