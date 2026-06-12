<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup;

use Mcoda\LaravelAgentSetup\Contracts\AgentSetupClient;
use Mcoda\LaravelAgentSetup\Contracts\AgentSetupStore;
use Mcoda\LaravelAgentSetup\Support\DefaultStages;
use RuntimeException;

final class McodaAgentSetupManager implements AgentSetupClient
{
    /**
     * @var array<string, list<string>>
     */
    private const CONNECTION_ALIASES = [
        'tenantId' => ['tenantId', 'tenant_id'],
        'productSlug' => ['productSlug', 'product_slug'],
        'apiKeyId' => ['apiKeyId', 'api_key_id'],
        'ownerUserId' => ['ownerUserId', 'owner_user_id'],
        'ownerKeycloakUserId' => ['ownerKeycloakUserId', 'owner_keycloak_user_id'],
        'featureKey' => ['featureKey', 'feature_key'],
        'installationId' => ['installationId', 'installation_id'],
        'installationStatus' => ['installationStatus', 'installation_status'],
    ];

    /**
     * @param array<string, mixed> $config
     */
    public function __construct(
        private readonly AgentSetupClient $remoteClient,
        private readonly AgentSetupStore $store,
        private readonly array $config,
    ) {
    }

    /**
     * @return array<string, mixed>
     */
    public function fetchSnapshot(): array
    {
        if ($this->remoteEnabled()) {
            return $this->remoteClient->fetchSnapshot();
        }

        return $this->localSnapshot([
            'backend' => 'No mcoda agent setup backend is configured. Set MCODA_AGENT_SETUP_BACKEND_URL to sync real agents.',
        ]);
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function configureMswarmApiKey(array $input): array
    {
        $payload = $this->normalizeMswarmApiKeyInput($input);

        if ($this->remoteEnabled()) {
            return $this->remoteClient->configureMswarmApiKey($payload);
        }

        $apiKey = (string) $payload['apiKey'];

        $this->store->saveMswarmKeyMetadata([
            'configured' => true,
            'last4' => substr($apiKey, -4),
            'configuredAt' => gmdate('c'),
            'connection' => $payload['connection'] ?? null,
        ]);

        return $this->localSnapshot([
            'backend' => 'mswarm API key metadata was saved locally, but real agent sync requires MCODA_AGENT_SETUP_BACKEND_URL.',
        ]);
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function syncAgents(array $input = []): array
    {
        if ($this->remoteEnabled()) {
            return $this->remoteClient->syncAgents($input);
        }

        return $this->localSnapshot([
            'sync' => 'Agent sync requires MCODA_AGENT_SETUP_BACKEND_URL or a custom Laravel binding.',
        ]);
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function updateAssignments(array $input): array
    {
        if ($this->remoteEnabled()) {
            return $this->remoteClient->updateAssignments($input);
        }

        $assignments = $input['assignments'] ?? [];
        if (! is_array($assignments)) {
            throw new RuntimeException('assignments must be an object.');
        }

        $this->store->saveAssignments($this->normalizeAssignments($assignments));

        return $this->localSnapshot([
            'backend' => 'Assignments were saved locally, but real agent validation requires MCODA_AGENT_SETUP_BACKEND_URL.',
        ]);
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function testAgent(array $input): array
    {
        if ($this->remoteEnabled()) {
            return $this->remoteClient->testAgent($input);
        }

        $slug = $input['slug'] ?? null;

        return [
            'slug' => is_string($slug) ? $slug : '',
            'ok' => false,
            'error' => 'Agent testing requires MCODA_AGENT_SETUP_BACKEND_URL or a custom Laravel binding.',
        ];
    }

    private function remoteEnabled(): bool
    {
        if (! method_exists($this->remoteClient, 'enabled')) {
            return false;
        }

        return $this->remoteClient->enabled() === true;
    }

    /**
     * @param array<string, mixed> $input
     * @return array{apiKey: string, connection: array<string, mixed>|null, reasonCode: string|null, metadata: array<string, mixed>|null}
     */
    private function normalizeMswarmApiKeyInput(array $input): array
    {
        $apiKey = $this->stringFromAliases($input, ['apiKey', 'mswarm_api_key', 'mswarmApiKey']);
        if (! is_string($apiKey) || trim($apiKey) === '') {
            throw new RuntimeException('mswarm_api_key is required.');
        }

        $metadata = $input['metadata'] ?? null;

        return [
            'apiKey' => $apiKey,
            'connection' => $this->connectionFromInput($input),
            'reasonCode' => $this->stringFromAliases($input, ['reasonCode', 'reason_code']),
            'metadata' => is_array($metadata) ? $metadata : null,
        ];
    }

    /**
     * @param array<string, string> $errors
     * @return array<string, mixed>
     */
    private function localSnapshot(array $errors = []): array
    {
        $settings = $this->store->load();
        $stages = $this->stages();
        $assignments = array_replace(
            DefaultStages::assignmentDefaults($stages),
            is_array($settings['assignments'] ?? null) ? $settings['assignments'] : [],
        );

        return [
            'provider' => 'mcoda_mswarm',
            'runtime' => [
                'mode' => 'custom',
                'requiresMcodaCli' => false,
            ],
            'mswarmApiKeyConfigured' => (bool) ($settings['mswarmApiKeyConfigured'] ?? false),
            'mswarmApiKeyLast4' => $settings['mswarmApiKeyLast4'] ?? null,
            'mswarmConfiguredAt' => $settings['mswarmConfiguredAt'] ?? null,
            'mswarmConnection' => $settings['mswarmConnection'] ?? null,
            'stages' => $stages,
            'assignments' => $assignments,
            'catalog' => [
                'localAgents' => [],
                'cloudAgents' => [],
                'selfHostedAgents' => [],
                'workerAgents' => [],
                'selfHostedServers' => [],
                'errors' => $errors,
                'generatedAt' => gmdate('c'),
            ],
            'updatedAt' => $settings['updatedAt'] ?? null,
            'fetchedAt' => gmdate('c'),
        ];
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function stages(): array
    {
        $stages = $this->config['stages'] ?? DefaultStages::all();

        return is_array($stages) ? array_values($stages) : DefaultStages::all();
    }

    /**
     * @param array<string, mixed> $assignments
     * @return array<string, string|null>
     */
    private function normalizeAssignments(array $assignments): array
    {
        $stageKeys = [];
        foreach ($this->stages() as $stage) {
            if (is_array($stage) && is_string($stage['stageKey'] ?? null)) {
                $stageKeys[(string) $stage['stageKey']] = true;
            }
        }

        $normalized = [];
        foreach ($assignments as $key => $value) {
            if (! is_string($key) || $key === '') {
                continue;
            }
            if ($stageKeys !== [] && ! isset($stageKeys[$key])) {
                throw new RuntimeException("Unknown mcoda stage assignment: {$key}");
            }
            $normalized[$key] = is_string($value) && $value !== '' ? $value : null;
        }

        return $normalized;
    }

    /**
     * @param array<string, mixed> $connection
     * @return array<string, mixed>
     */
    private function normalizeConnection(array $connection): array
    {
        $metadata = [];
        foreach (self::CONNECTION_ALIASES as $key => $aliases) {
            $metadata[$key] = $this->stringFromAliases($connection, $aliases);
        }

        $metadata['validationStatus'] = 'unverified';
        $metadata['validationErrors'] = [];
        $metadata['validatedAt'] = null;

        return $metadata;
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>|null
     */
    private function connectionFromInput(array $input): ?array
    {
        $connection = $input['connection'] ?? $input['mswarm_connection'] ?? null;
        if (is_array($connection)) {
            return $this->normalizeConnection($connection);
        }

        foreach (self::CONNECTION_ALIASES as $aliases) {
            if ($this->stringFromAliases($input, $aliases) !== null) {
                return $this->normalizeConnection($input);
            }
        }

        return null;
    }

    /**
     * @param array<string, mixed> $source
     * @param list<string> $keys
     */
    private function stringFromAliases(array $source, array $keys): ?string
    {
        foreach ($keys as $key) {
            $value = $source[$key] ?? null;
            if (is_string($value) && trim($value) !== '') {
                return $value;
            }
        }

        return null;
    }
}
