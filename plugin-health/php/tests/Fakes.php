<?php

declare(strict_types=1);

namespace Supertext\PluginHealth\Tests;

use Supertext\PluginHealth\Http\HttpRequest;
use Supertext\PluginHealth\Http\HttpResponse;
use Supertext\PluginHealth\Http\HttpTransport;
use Supertext\PluginHealth\Http\TransportException;
use Supertext\PluginHealth\KeyChecker;

/**
 * Fake key checker (returns the step's keyCheck, fingerprints from the spec's table) and fake center
 * (answers the step's report status or a transport error). Both record their calls in order, and any
 * unexpected call in $errors (the reporter swallows exceptions, so the test checks $errors).
 */
final class Fakes implements KeyChecker, HttpTransport
{
    /** @var list<string> */
    public array $calls = [];

    /** @var list<HttpRequest> */
    public array $reports = [];

    /** @var list<string> */
    public array $errors = [];

    /**
     * @param array<array-key, mixed>|null $keyCheck  what check() returns (a list: one per call, in order); null: not expected
     * @param array<string, mixed>|null $report       the center's answer: ['status' => int] or ['transportError' => true]; null: not expected
     * @param array<string, string>     $fingerprints apiKey → fingerprint
     */
    public function __construct(
        private ?array $keyCheck,
        private readonly ?array $report,
        private readonly array $fingerprints,
    ) {
    }

    /** @return array<string, mixed> */
    public function check(#[\SensitiveParameter] string $apiKey): array
    {
        $this->calls[] = 'keyCheck';
        $next = $this->keyCheck;
        if ($next !== null && array_is_list($next)) {
            $next = array_shift($this->keyCheck);
            $this->keyCheck = $this->keyCheck === [] ? null : $this->keyCheck;
        }
        if (!\is_array($next)) {
            $this->errors[] = 'unexpected key check';
            throw new \LogicException('unexpected key check');
        }

        /** @var array<string, mixed> $next */
        return $next;
    }

    public function fingerprint(#[\SensitiveParameter] string $apiKey): string
    {
        if (!\array_key_exists($apiKey, $this->fingerprints)) {
            $this->errors[] = 'no fingerprint for ' . json_encode($apiKey);
            throw new \LogicException('no fingerprint');
        }

        return $this->fingerprints[$apiKey];
    }

    public function send(HttpRequest $request): HttpResponse
    {
        $this->calls[] = 'report';
        $this->reports[] = $request;
        if ($this->report === null) {
            $this->errors[] = 'unexpected report';
            throw new \LogicException('unexpected report');
        }
        if (($this->report['transportError'] ?? false) === true) {
            throw new TransportException('connection refused');
        }
        $status = $this->report['status'] ?? 202;

        return new HttpResponse(\is_int($status) ? $status : 202);
    }
}
