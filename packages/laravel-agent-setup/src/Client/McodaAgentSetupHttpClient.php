<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Client;

use Illuminate\Http\Client\Factory as HttpFactory;
use Mcoda\LaravelAgentSetup\Contracts\AgentSetupClient;
use RuntimeException;

final class McodaAgentSetupHttpClient implements AgentSetupClient
{
    public function __construct(
        private readonly HttpFactory $http,
        private readonly ?string $baseUrl,
        private readonly ?string $backendToken = null,
        private readonly string $backendAuthHeader = 'Authorization',
        private readonly int $timeoutSeconds = 30,
    ) {
    }

    public function enabled(): bool
    {
        return is_string($this->baseUrl) && trim($this->baseUrl) !== '';
    }

    /**
     * @return array<string, mixed>
     */
    public function fetchSnapshot(): array
    {
        return $this->request('GET', '/agent-settings');
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function configureMswarmApiKey(array $input): array
    {
        return $this->request('POST', '/mswarm-api-key', [
            'mswarm_api_key' => $input['apiKey'] ?? $input['mswarm_api_key'] ?? $input['mswarmApiKey'] ?? null,
            'connection' => $input['connection'] ?? $input['mswarm_connection'] ?? null,
            'reason_code' => $input['reasonCode'] ?? $input['reason_code'] ?? null,
            'metadata' => $input['metadata'] ?? null,
        ]);
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function syncAgents(array $input = []): array
    {
        return $this->request('POST', '/agents/sync', [
            'reason_code' => $input['reasonCode'] ?? $input['reason_code'] ?? null,
            'metadata' => $input['metadata'] ?? null,
        ]);
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function updateAssignments(array $input): array
    {
        return $this->request('PATCH', '/agent-settings', [
            'assignments' => $input['assignments'] ?? [],
            'reason_code' => $input['reasonCode'] ?? $input['reason_code'] ?? null,
            'metadata' => $input['metadata'] ?? null,
        ]);
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function testAgent(array $input): array
    {
        return $this->request('POST', '/agents/test', [
            'slug' => $input['slug'] ?? null,
            'prompt' => $input['prompt'] ?? null,
            'timeout_ms' => $input['timeoutMs'] ?? $input['timeout_ms'] ?? null,
        ]);
    }

    /**
     * @param array<string, mixed>|null $payload
     * @return array<string, mixed>
     */
    private function request(string $method, string $path, ?array $payload = null): array
    {
        if (! $this->enabled()) {
            throw new RuntimeException('MCODA_AGENT_SETUP_BACKEND_URL is not configured.');
        }

        $headers = ['Accept' => 'application/json'];
        if (is_string($this->backendToken) && $this->backendToken !== '') {
            $headers[$this->backendAuthHeader] = str_starts_with($this->backendToken, 'Bearer ')
                ? $this->backendToken
                : "Bearer {$this->backendToken}";
        }

        $request = $this->http->timeout($this->timeoutSeconds)->withHeaders($headers)->acceptJson();
        $url = rtrim((string) $this->baseUrl, '/') . $path;
        $response = $payload === null
            ? $request->send($method, $url)
            : $request->send($method, $url, ['json' => $payload]);

        if (! $response->successful()) {
            $error = $response->json('error') ?? $response->body();
            $message = is_string($error) && trim($error) !== ''
                ? trim($error)
                : "{$response->status()} {$response->reason()}";
            throw new RuntimeException("mcoda agent setup request failed: {$message}");
        }

        $decoded = $response->json();
        if (! is_array($decoded)) {
            throw new RuntimeException('mcoda agent setup response was not a JSON object.');
        }

        /** @var array<string, mixed> $decoded */
        return $decoded;
    }
}
