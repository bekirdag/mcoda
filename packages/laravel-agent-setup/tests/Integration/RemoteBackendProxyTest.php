<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Tests\Integration;

use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Http;
use Mcoda\LaravelAgentSetup\McodaAgentSetupServiceProvider;
use Orchestra\Testbench\TestCase;

final class RemoteBackendProxyTest extends TestCase
{
    protected function setUp(): void
    {
        @unlink(self::settingsPath());

        parent::setUp();
    }

    protected function tearDown(): void
    {
        parent::tearDown();

        @unlink(self::settingsPath());
    }

    protected function getPackageProviders($app): array
    {
        return [
            McodaAgentSetupServiceProvider::class,
        ];
    }

    protected function defineEnvironment($app): void
    {
        $app['config']->set('mcoda-agent-setup.storage_path', self::settingsPath());
        $app['config']->set('mcoda-agent-setup.web_middleware', []);
        $app['config']->set('mcoda-agent-setup.api_middleware', []);
        $app['config']->set('mcoda-agent-setup.backend_url', self::backendBaseUrl() . '/');
        $app['config']->set('mcoda-agent-setup.backend_token', 'integration-token');
        $app['config']->set('mcoda-agent-setup.backend_auth_header', 'X-Mcoda-Backend-Token');
    }

    public function test_snapshot_route_uses_configured_remote_backend_and_custom_auth_header(): void
    {
        Http::fake([
            self::backendUrl('/agent-settings') => Http::response([
                'provider' => 'remote_mswarm',
                'runtime' => ['mode' => 'remote'],
            ]),
        ]);

        $this->getJson('/mcoda-agent-setup/api/agent-settings')
            ->assertOk()
            ->assertJsonPath('provider', 'remote_mswarm')
            ->assertJsonPath('runtime.mode', 'remote');

        $request = $this->sentRequest('GET', '/agent-settings');

        $this->assertTrue($request->hasHeader('X-Mcoda-Backend-Token', 'Bearer integration-token'));
        $this->assertFalse($request->hasHeader('Authorization'));
    }

    public function test_prefixed_backend_token_is_not_prefixed_twice(): void
    {
        config()->set('mcoda-agent-setup.backend_token', 'Bearer already-prefixed-token');

        Http::fake([
            self::backendUrl('/agent-settings') => Http::response([
                'provider' => 'remote_mswarm',
            ]),
        ]);

        $this->getJson('/mcoda-agent-setup/api/agent-settings')
            ->assertOk()
            ->assertJsonPath('provider', 'remote_mswarm');

        $request = $this->sentRequest('GET', '/agent-settings');

        $this->assertTrue($request->hasHeader('X-Mcoda-Backend-Token', 'Bearer already-prefixed-token'));
        $this->assertFalse($request->hasHeader('X-Mcoda-Backend-Token', 'Bearer Bearer already-prefixed-token'));
    }

    public function test_remote_write_routes_forward_node_compatible_payloads(): void
    {
        Http::fake([
            self::backendUrl('/mswarm-api-key') => Http::response(['kind' => 'api-key']),
            self::backendUrl('/agents/sync') => Http::response(['kind' => 'sync']),
            self::backendUrl('/agent-settings') => Http::response(['kind' => 'assignments']),
            self::backendUrl('/agents/test') => Http::response(['kind' => 'test-agent']),
        ]);

        $this->postJson('/mcoda-agent-setup/api/mswarm-api-key', [
            'mswarmApiKey' => 'mswarm_remote_secret_2468',
            'tenant_id' => 'tenant-remote',
            'product_slug' => 'remote-product',
            'api_key_id' => 'api-key-remote',
            'reasonCode' => 'remote_setup',
            'metadata' => ['source' => 'phpunit'],
        ])
            ->assertOk()
            ->assertJsonPath('kind', 'api-key');

        $this->postJson('/mcoda-agent-setup/api/agents/sync', [
            'reasonCode' => 'remote_sync',
            'metadata' => ['source' => 'sync-test'],
        ])
            ->assertOk()
            ->assertJsonPath('kind', 'sync');

        $this->patchJson('/mcoda-agent-setup/api/agent-settings', [
            'assignments' => [
                'translation' => 'mswarm-cloud-demo-translator',
                'review' => null,
            ],
            'reasonCode' => 'remote_assignment_update',
            'metadata' => ['source' => 'assignment-test'],
        ])
            ->assertOk()
            ->assertJsonPath('kind', 'assignments');

        $this->postJson('/mcoda-agent-setup/api/agents/test', [
            'slug' => 'mswarm-cloud-demo-translator',
            'prompt' => 'Translate this sample.',
            'timeoutMs' => 2500,
        ])
            ->assertOk()
            ->assertJsonPath('kind', 'test-agent');

        $this->assertCount(4, $this->recordedRequests());

        $apiKeyPayload = $this->sentRequest('POST', '/mswarm-api-key')->data();
        $this->assertSame('mswarm_remote_secret_2468', $apiKeyPayload['mswarm_api_key']);
        $this->assertSame('remote_setup', $apiKeyPayload['reason_code']);
        $this->assertSame(['source' => 'phpunit'], $apiKeyPayload['metadata']);
        $this->assertSame('tenant-remote', $apiKeyPayload['connection']['tenantId']);
        $this->assertSame('remote-product', $apiKeyPayload['connection']['productSlug']);
        $this->assertSame('api-key-remote', $apiKeyPayload['connection']['apiKeyId']);
        $this->assertSame('unverified', $apiKeyPayload['connection']['validationStatus']);
        $this->assertArrayNotHasKey('mswarmApiKey', $apiKeyPayload);
        $this->assertArrayNotHasKey('reasonCode', $apiKeyPayload);

        $syncPayload = $this->sentRequest('POST', '/agents/sync')->data();
        $this->assertSame('remote_sync', $syncPayload['reason_code']);
        $this->assertSame(['source' => 'sync-test'], $syncPayload['metadata']);
        $this->assertArrayNotHasKey('reasonCode', $syncPayload);

        $assignmentsPayload = $this->sentRequest('PATCH', '/agent-settings')->data();
        $this->assertSame(
            'mswarm-cloud-demo-translator',
            $assignmentsPayload['assignments']['translation']
        );
        $this->assertNull($assignmentsPayload['assignments']['review']);
        $this->assertSame('remote_assignment_update', $assignmentsPayload['reason_code']);
        $this->assertSame(['source' => 'assignment-test'], $assignmentsPayload['metadata']);

        $testPayload = $this->sentRequest('POST', '/agents/test')->data();
        $this->assertSame('mswarm-cloud-demo-translator', $testPayload['slug']);
        $this->assertSame('Translate this sample.', $testPayload['prompt']);
        $this->assertSame(2500, $testPayload['timeout_ms']);
        $this->assertArrayNotHasKey('timeoutMs', $testPayload);
    }

    public function test_remote_api_key_route_normalizes_api_key_and_mswarm_connection_aliases(): void
    {
        Http::fake([
            self::backendUrl('/mswarm-api-key') => Http::response(['kind' => 'api-key']),
        ]);

        $this->postJson('/mcoda-agent-setup/api/mswarm-api-key', [
            'apiKey' => 'mswarm_alias_secret_1357',
            'mswarm_connection' => [
                'tenant_id' => 'tenant-alias',
                'product_slug' => 'alias-product',
                'owner_user_id' => 'owner-alias',
                'owner_keycloak_user_id' => 'keycloak-alias',
                'feature_key' => 'feature-alias',
                'installation_id' => 'install-alias',
                'installation_status' => 'active',
            ],
            'reasonCode' => 'remote_alias_setup',
            'metadata' => ['source' => 'alias-test'],
        ])
            ->assertOk()
            ->assertJsonPath('kind', 'api-key');

        $payload = $this->sentRequest('POST', '/mswarm-api-key')->data();
        $this->assertSame('mswarm_alias_secret_1357', $payload['mswarm_api_key']);
        $this->assertSame('remote_alias_setup', $payload['reason_code']);
        $this->assertSame(['source' => 'alias-test'], $payload['metadata']);
        $this->assertSame('tenant-alias', $payload['connection']['tenantId']);
        $this->assertSame('alias-product', $payload['connection']['productSlug']);
        $this->assertSame('owner-alias', $payload['connection']['ownerUserId']);
        $this->assertSame('keycloak-alias', $payload['connection']['ownerKeycloakUserId']);
        $this->assertSame('feature-alias', $payload['connection']['featureKey']);
        $this->assertSame('install-alias', $payload['connection']['installationId']);
        $this->assertSame('active', $payload['connection']['installationStatus']);
        $this->assertSame('unverified', $payload['connection']['validationStatus']);
        $this->assertArrayNotHasKey('apiKey', $payload);
        $this->assertArrayNotHasKey('mswarm_connection', $payload);
        $this->assertArrayNotHasKey('reasonCode', $payload);
    }

    public function test_backend_errors_are_mapped_to_laravel_json_errors(): void
    {
        Http::fake([
            self::backendUrl('/agents/sync') => Http::response([
                'error' => 'remote sync failed',
            ], 503),
        ]);

        $this->postJson('/mcoda-agent-setup/api/agents/sync', [
            'reasonCode' => 'remote_sync',
        ])
            ->assertStatus(422)
            ->assertJsonPath('error', 'mcoda agent setup request failed: remote sync failed');

        $syncPayload = $this->sentRequest('POST', '/agents/sync')->data();
        $this->assertSame('remote_sync', $syncPayload['reason_code']);
    }

    /**
     * @return list<HttpRequest>
     */
    private function recordedRequests(): array
    {
        return Http::recorded()
            ->map(static fn (array $record): HttpRequest => $record[0])
            ->values()
            ->all();
    }

    private function sentRequest(string $method, string $path): HttpRequest
    {
        $url = self::backendUrl($path);
        $requests = array_values(array_filter(
            $this->recordedRequests(),
            static fn (HttpRequest $request): bool => $request->method() === $method && $request->url() === $url,
        ));

        $this->assertCount(1, $requests, "Expected exactly one {$method} request to {$url}.");

        return $requests[0];
    }

    private static function backendBaseUrl(): string
    {
        return 'https://mcoda-backend.example.test/api/mcoda';
    }

    private static function backendUrl(string $path): string
    {
        return self::backendBaseUrl() . $path;
    }

    private static function settingsPath(): string
    {
        return sys_get_temp_dir() . '/mcoda-laravel-agent-setup-remote-' . getmypid() . '.json';
    }
}
