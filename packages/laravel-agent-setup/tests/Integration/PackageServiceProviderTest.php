<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Tests\Integration;

use Mcoda\LaravelAgentSetup\Contracts\AgentSetupClient;
use Mcoda\LaravelAgentSetup\Facades\McodaAgentSetup;
use Mcoda\LaravelAgentSetup\McodaAgentSetupManager;
use Mcoda\LaravelAgentSetup\McodaAgentSetupServiceProvider;
use Orchestra\Testbench\TestCase;

final class PackageServiceProviderTest extends TestCase
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

    protected function getPackageAliases($app): array
    {
        return [
            'McodaAgentSetup' => McodaAgentSetup::class,
        ];
    }

    protected function defineEnvironment($app): void
    {
        $app['config']->set('mcoda-agent-setup.storage_path', self::settingsPath());
        $app['config']->set('mcoda-agent-setup.web_middleware', []);
        $app['config']->set('mcoda-agent-setup.api_middleware', []);
    }

    public function test_service_provider_registers_manager_binding_and_facade(): void
    {
        $manager = $this->app->make('mcoda-agent-setup');

        $this->assertInstanceOf(McodaAgentSetupManager::class, $manager);
        $this->assertSame($manager, $this->app->make(McodaAgentSetupManager::class));
        $this->assertSame($manager, $this->app->make(AgentSetupClient::class));
        $this->assertSame('mcoda-agent-setup', config('mcoda-agent-setup.web_path'));

        $snapshot = McodaAgentSetup::fetchSnapshot();

        $this->assertSame('mcoda_mswarm', $snapshot['provider']);
        $this->assertSame('custom', $snapshot['runtime']['mode']);
    }

    public function test_api_snapshot_route_uses_local_fallback(): void
    {
        $this->assertSame(
            url('/mcoda-agent-setup/api/agent-settings'),
            route('mcoda-agent-setup.api.snapshot')
        );

        $this->getJson('/mcoda-agent-setup/api/agent-settings')
            ->assertOk()
            ->assertJsonPath('provider', 'mcoda_mswarm')
            ->assertJsonPath('runtime.mode', 'custom')
            ->assertJsonPath(
                'catalog.errors.backend',
                'No mcoda agent setup backend is configured. Set MCODA_AGENT_SETUP_BACKEND_URL to sync real agents.'
            );
    }

    public function test_api_key_route_accepts_aliases_and_does_not_persist_secret(): void
    {
        $this->postJson('/mcoda-agent-setup/api/mswarm-api-key', [
            'mswarmApiKey' => 'mswarm_integration_secret_9876',
            'tenant_id' => 'tenant-integration',
            'product_slug' => 'demo-product',
            'reasonCode' => 'integration_setup',
            'metadata' => ['source' => 'phpunit'],
        ])
            ->assertOk()
            ->assertJsonPath('mswarmApiKeyConfigured', true)
            ->assertJsonPath('mswarmApiKeyLast4', '9876')
            ->assertJsonPath('mswarmConnection.tenantId', 'tenant-integration')
            ->assertJsonPath('mswarmConnection.productSlug', 'demo-product');

        $raw = file_get_contents(self::settingsPath());

        $this->assertIsString($raw);
        $this->assertStringContainsString('9876', $raw);
        $this->assertStringNotContainsString('mswarm_integration_secret_9876', $raw);
    }

    public function test_assignments_round_trip_through_api_route(): void
    {
        $this->assertSame(
            url('/mcoda-agent-setup/api/agent-settings'),
            route('mcoda-agent-setup.api.assignments')
        );

        $this->patchJson('/mcoda-agent-setup/api/agent-settings', [
            'assignments' => [
                'translation' => 'mswarm-cloud-demo-translator',
                'review' => null,
            ],
            'reason_code' => 'integration_assignment_update',
        ])
            ->assertOk()
            ->assertJsonPath('assignments.translation', 'mswarm-cloud-demo-translator')
            ->assertJsonPath('assignments.review', null);

        $this->getJson('/mcoda-agent-setup/api/agent-settings')
            ->assertOk()
            ->assertJsonPath('assignments.translation', 'mswarm-cloud-demo-translator')
            ->assertJsonPath('assignments.review', null);
    }

    public function test_sync_and_test_agent_routes_fail_closed_in_local_fallback(): void
    {
        $this->assertSame(
            url('/mcoda-agent-setup/api/agents/sync'),
            route('mcoda-agent-setup.api.sync')
        );
        $this->assertSame(
            url('/mcoda-agent-setup/api/agents/test'),
            route('mcoda-agent-setup.api.test-agent')
        );

        $this->postJson('/mcoda-agent-setup/api/agents/sync', [
            'reasonCode' => 'integration_sync',
            'metadata' => ['source' => 'phpunit'],
        ])
            ->assertOk()
            ->assertJsonPath('provider', 'mcoda_mswarm')
            ->assertJsonPath(
                'catalog.errors.sync',
                'Agent sync requires MCODA_AGENT_SETUP_BACKEND_URL or a custom Laravel binding.'
            );

        $this->postJson('/mcoda-agent-setup/api/agents/test', [
            'slug' => 'mswarm-cloud-demo-translator',
            'prompt' => 'Translate this sample.',
            'timeoutMs' => 1250,
        ])
            ->assertOk()
            ->assertJsonPath('slug', 'mswarm-cloud-demo-translator')
            ->assertJsonPath('ok', false)
            ->assertJsonPath(
                'error',
                'Agent testing requires MCODA_AGENT_SETUP_BACKEND_URL or a custom Laravel binding.'
            );
    }

    public function test_invalid_assignment_returns_validation_error(): void
    {
        $this->patchJson('/mcoda-agent-setup/api/agent-settings', [
            'assignments' => ['unknown_stage' => 'agent-a'],
        ])
            ->assertStatus(422)
            ->assertJsonPath('error', 'Unknown mcoda stage assignment: unknown_stage');
    }

    public function test_web_route_renders_blade_setup_page(): void
    {
        $this->get('/mcoda-agent-setup')
            ->assertOk()
            ->assertSee('mcoda Agent Setup')
            ->assertSee('mswarm API key');
    }

    private static function settingsPath(): string
    {
        return sys_get_temp_dir() . '/mcoda-laravel-agent-setup-integration-' . getmypid() . '.json';
    }
}
