<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Client;

use Illuminate\Http\Client\Factory as HttpFactory;
use Mcoda\LaravelAgentSetup\Contracts\GpuJobClient;
use Mcoda\LaravelAgentSetup\Support\GpuJobToken;
use RuntimeException;

final class McodaGpuJobHttpClient implements GpuJobClient
{
    /**
     * @param array<string, mixed> $defaults
     */
    public function __construct(
        private readonly HttpFactory $http,
        private readonly array $defaults = [],
        private readonly int $timeoutSeconds = 30,
    ) {
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function listGpus(array $input = []): array
    {
        return $this->request('GET', '/v1/swarm/self-hosted/node/capabilities', null, $input, 'capability');
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function ops(array $input = []): array
    {
        $query = [];
        $auditLimit = $input['auditLimit'] ?? $input['audit_limit'] ?? null;
        $auditOffset = $input['auditOffset'] ?? $input['audit_offset'] ?? null;
        if (is_int($auditLimit) || (is_string($auditLimit) && ctype_digit($auditLimit))) {
            $query['audit_limit'] = (string) $auditLimit;
        }
        if (is_int($auditOffset) || (is_string($auditOffset) && ctype_digit($auditOffset))) {
            $query['audit_offset'] = (string) $auditOffset;
        }
        $path = '/v1/swarm/self-hosted/node/generic-job-control/ops';
        if ($query !== []) {
            $path .= '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
        }

        return $this->request('GET', $path, null, $input, 'ops');
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function uploadArtifact(array $input): array
    {
        $jobId = $this->requireString($input['jobId'] ?? $input['job_id'] ?? null, 'jobId');

        return $this->request(
            'POST',
            '/v1/swarm/self-hosted/node/generic-job-control/jobs/' . rawurlencode($jobId) . '/artifacts',
            [
                'name' => $input['name'] ?? null,
                'path' => $input['path'] ?? null,
                'content_base64' => $input['contentBase64'] ?? $input['content_base64'] ?? null,
                'content_type' => $input['contentType'] ?? $input['content_type'] ?? null,
                'sha256' => $input['sha256'] ?? null,
                'size_bytes' => $input['sizeBytes'] ?? $input['size_bytes'] ?? null,
            ],
            $input,
            'generic'
        );
    }

    /**
     * @param array<string, mixed> $job
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function create(array $job, array $input = []): array
    {
        return $this->runJob($job, $input);
    }

    /**
     * @param array<string, mixed> $job
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function runJob(array $job, array $input = []): array
    {
        $reference = array_replace($input, $this->referenceFromJob($job));

        return $this->request(
            'POST',
            '/v1/swarm/self-hosted/node/generic-job-control/jobs',
            $job,
            $reference,
            'generic'
        );
    }

    public function status(array $input): array
    {
        return $this->jobRead('GET', $input, '');
    }

    public function logs(array $input): array
    {
        return $this->jobRead('GET', $input, '/logs');
    }

    public function events(array $input): array
    {
        return $this->jobRead('GET', $input, '/events');
    }

    public function artifacts(array $input): array
    {
        return $this->jobRead('GET', $input, '/artifacts');
    }

    public function cancel(array $input): array
    {
        return $this->jobRead('POST', $input, '/cancel');
    }

    public function retry(array $input): array
    {
        return $this->jobRead('POST', $input, '/retry');
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    private function jobRead(string $method, array $input, string $suffix): array
    {
        $jobId = $this->requireString($input['jobId'] ?? $input['job_id'] ?? null, 'jobId');

        return $this->request(
            $method,
            '/v1/swarm/self-hosted/node/generic-job-control/jobs/' . rawurlencode($jobId) . $suffix,
            null,
            $input,
            'generic'
        );
    }

    /**
     * @param array<string, mixed>|null $payload
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    private function request(string $method, string $path, ?array $payload, array $input, string $tokenType): array
    {
        $baseUrl = rtrim($this->requireString($input['nodeBaseUrl'] ?? $input['node_base_url'] ?? $this->defaults['node_base_url'] ?? null, 'nodeBaseUrl'), '/');
        $headers = [
            'Accept' => 'application/json',
            'Authorization' => 'Bearer ' . $this->token($input, $tokenType),
        ];
        $request = $this->http->timeout($this->timeoutSeconds)->withHeaders($headers)->acceptJson();
        $response = $payload === null
            ? $request->send($method, $baseUrl . $path)
            : $request->send($method, $baseUrl . $path, ['json' => $payload]);

        if (! $response->successful()) {
            $error = $response->json('message') ?? $response->json('error') ?? $response->body();
            $message = is_string($error) && trim($error) !== ''
                ? trim($error)
                : "{$response->status()} {$response->reason()}";
            throw new RuntimeException("mcoda gpu job request failed: {$message}");
        }

        $decoded = $response->json();
        if (! is_array($decoded)) {
            throw new RuntimeException('mcoda gpu job response was not a JSON object.');
        }

        /** @var array<string, mixed> $decoded */
        return $decoded;
    }

    /**
     * @param array<string, mixed> $input
     */
    private function token(array $input, string $type): string
    {
        if ($type === 'ops') {
            $opsToken = $input['opsToken'] ?? $input['ops_token'] ?? $this->defaults['opsToken'] ?? $this->defaults['ops_token'] ?? null;
            if (is_string($opsToken) && trim($opsToken) !== '') {
                return trim($opsToken);
            }
        }

        $token = $input['token'] ?? $this->defaults['token'] ?? null;
        if (is_string($token) && trim($token) !== '') {
            return trim($token);
        }

        $merged = array_replace($this->defaults, $input);

        return match ($type) {
            'capability' => GpuJobToken::capability($merged),
            'ops' => GpuJobToken::ops($merged),
            default => GpuJobToken::genericJob($merged),
        };
    }

    /**
     * @param array<string, mixed> $job
     * @return array<string, mixed>
     */
    private function referenceFromJob(array $job): array
    {
        $request = is_array($job['job'] ?? null) ? $job['job'] : [];

        return [
            'jobId' => $job['job_id'] ?? null,
            'requestId' => $job['request_id'] ?? null,
            'nodeId' => $job['node_id'] ?? null,
            'schemaVersion' => $request['schema_version'] ?? null,
            'jobType' => $request['job_type'] ?? null,
        ];
    }

    private function requireString(mixed $value, string $label): string
    {
        if (! is_string($value) || trim($value) === '') {
            throw new RuntimeException("{$label} is required.");
        }

        return trim($value);
    }
}
