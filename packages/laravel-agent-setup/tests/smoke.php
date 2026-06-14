<?php

declare(strict_types=1);

require_once __DIR__ . '/../src/Contracts/AgentSetupClient.php';
require_once __DIR__ . '/../src/Contracts/AgentSetupStore.php';
require_once __DIR__ . '/../src/Contracts/GpuJobClient.php';
require_once __DIR__ . '/../src/Support/DefaultStages.php';
require_once __DIR__ . '/../src/Support/GpuJobToken.php';
require_once __DIR__ . '/../src/Support/RequestPayload.php';
require_once __DIR__ . '/../src/Storage/FileAgentSetupStore.php';
require_once __DIR__ . '/../src/McodaAgentSetupManager.php';

use Mcoda\LaravelAgentSetup\Contracts\AgentSetupClient;
use Mcoda\LaravelAgentSetup\McodaAgentSetupManager;
use Mcoda\LaravelAgentSetup\Storage\FileAgentSetupStore;
use Mcoda\LaravelAgentSetup\Support\DefaultStages;
use Mcoda\LaravelAgentSetup\Support\GpuJobToken;
use Mcoda\LaravelAgentSetup\Support\RequestPayload;

final class DisabledRemoteClient implements AgentSetupClient
{
    public function enabled(): bool
    {
        return false;
    }

    public function fetchSnapshot(): array
    {
        return [];
    }

    public function configureMswarmApiKey(array $input): array
    {
        return [];
    }

    public function syncAgents(array $input = []): array
    {
        return [];
    }

    public function updateAssignments(array $input): array
    {
        return [];
    }

    public function testAgent(array $input): array
    {
        return [];
    }
}

final class RecordingRemoteClient implements AgentSetupClient
{
    /**
     * @var array<string, mixed>
     */
    public array $lastConfigureInput = [];

    public function enabled(): bool
    {
        return true;
    }

    public function fetchSnapshot(): array
    {
        return [];
    }

    public function configureMswarmApiKey(array $input): array
    {
        $this->lastConfigureInput = $input;

        return ['ok' => true, 'input' => $input];
    }

    public function syncAgents(array $input = []): array
    {
        return [];
    }

    public function updateAssignments(array $input): array
    {
        return [];
    }

    public function testAgent(array $input): array
    {
        return [];
    }
}

$assert = static function (bool $condition, string $message): void {
    if (! $condition) {
        fwrite(STDERR, $message . PHP_EOL);
        exit(1);
    }
};

$storePath = sys_get_temp_dir() . '/mcoda-laravel-agent-setup-' . bin2hex(random_bytes(6)) . '.json';
$store = new FileAgentSetupStore($storePath);
$manager = new McodaAgentSetupManager(new DisabledRemoteClient(), $store, [
    'stages' => DefaultStages::all(),
]);

$snapshot = $manager->fetchSnapshot();
$assert($snapshot['provider'] === 'mcoda_mswarm', 'snapshot provider should match Node SDK provider');
$assert($snapshot['runtime']['mode'] === 'custom', 'local fallback runtime should be custom');
$assert(isset($snapshot['catalog']['errors']['backend']), 'local fallback should report backend warning');
$assert(count($snapshot['stages']) >= 4, 'default stages should be present');

$snapshot = $manager->configureMswarmApiKey([
    'mswarm_api_key' => 'mswarm_test_secret_123456',
    'connection' => ['tenantId' => 'tenant-a', 'productSlug' => 'demo'],
]);
$assert($snapshot['mswarmApiKeyConfigured'] === true, 'API key metadata should be configured');
$assert($snapshot['mswarmApiKeyLast4'] === '3456', 'API key last4 should be stored');
$assert($snapshot['mswarmConnection']['tenantId'] === 'tenant-a', 'camelCase tenant connection should be stored');
$assert($snapshot['mswarmConnection']['productSlug'] === 'demo', 'camelCase product connection should be stored');

$raw = file_get_contents($storePath);
$assert(is_string($raw), 'store file should be readable');
$assert(! str_contains($raw, 'mswarm_test_secret_123456'), 'full API key must not be persisted');
$assert(str_contains($raw, '3456'), 'last4 metadata should be persisted');

$payload = [
    'apiKey' => 'mswarm_test_secret_abcdef',
    'mswarm_connection' => [
        'tenant_id' => 'tenant-snake',
        'product_slug' => 'snake-product',
        'api_key_id' => 'api-key-snake',
        'owner_user_id' => 'owner-snake',
        'owner_keycloak_user_id' => 'keycloak-snake',
        'feature_key' => 'feature-snake',
        'installation_id' => 'install-snake',
        'installation_status' => 'active',
    ],
    'reasonCode' => 'setup_admin',
    'timeoutMs' => 1500,
];
$assert(RequestPayload::apiKey($payload) === 'mswarm_test_secret_abcdef', 'apiKey alias should map to mswarm API key');
$assert(RequestPayload::reasonCode($payload) === 'setup_admin', 'reasonCode alias should map to reason_code');
$assert(RequestPayload::timeoutMs($payload) === 1500, 'timeoutMs alias should map to timeout_ms');
$connection = RequestPayload::connection($payload);
$assert(is_array($connection) && $connection['tenant_id'] === 'tenant-snake', 'mswarm_connection alias should map to connection');

$snapshot = $manager->configureMswarmApiKey($payload);
$assert($snapshot['mswarmApiKeyLast4'] === 'cdef', 'apiKey alias should configure API key metadata');
$assert($snapshot['mswarmConnection']['tenantId'] === 'tenant-snake', 'snake_case tenant connection should be normalized');
$assert($snapshot['mswarmConnection']['productSlug'] === 'snake-product', 'snake_case product connection should be normalized');
$assert($snapshot['mswarmConnection']['apiKeyId'] === 'api-key-snake', 'snake_case API key id should be normalized');
$assert($snapshot['mswarmConnection']['ownerUserId'] === 'owner-snake', 'snake_case owner user id should be normalized');
$assert($snapshot['mswarmConnection']['ownerKeycloakUserId'] === 'keycloak-snake', 'snake_case owner Keycloak id should be normalized');
$assert($snapshot['mswarmConnection']['featureKey'] === 'feature-snake', 'snake_case feature key should be normalized');
$assert($snapshot['mswarmConnection']['installationId'] === 'install-snake', 'snake_case installation id should be normalized');
$assert($snapshot['mswarmConnection']['installationStatus'] === 'active', 'snake_case installation status should be normalized');

$raw = file_get_contents($storePath);
$assert(is_string($raw), 'store file should still be readable');
$assert(! str_contains($raw, 'mswarm_test_secret_abcdef'), 'full alias API key must not be persisted');
$assert(str_contains($raw, 'cdef'), 'alias API key last4 metadata should be persisted');

$remote = new RecordingRemoteClient();
$remoteManager = new McodaAgentSetupManager($remote, $store, [
    'stages' => DefaultStages::all(),
]);
$remoteResult = $remoteManager->configureMswarmApiKey([
    'mswarmApiKey' => 'mswarm_remote_secret_9876',
    'tenant_id' => 'tenant-remote',
    'product_slug' => 'remote-product',
    'reason_code' => 'remote_admin_setup',
    'metadata' => ['source' => 'smoke'],
]);
$assert($remoteResult['ok'] === true, 'remote setup path should return the remote result');
$assert($remote->lastConfigureInput['apiKey'] === 'mswarm_remote_secret_9876', 'remote setup should normalize mswarmApiKey to apiKey');
$assert($remote->lastConfigureInput['connection']['tenantId'] === 'tenant-remote', 'remote setup should normalize top-level tenant_id');
$assert($remote->lastConfigureInput['connection']['productSlug'] === 'remote-product', 'remote setup should normalize top-level product_slug');
$assert($remote->lastConfigureInput['reasonCode'] === 'remote_admin_setup', 'remote setup should normalize reason_code to reasonCode');
$assert($remote->lastConfigureInput['metadata']['source'] === 'smoke', 'remote setup should preserve metadata');

$snapshot = $manager->updateAssignments([
    'assignments' => [
        'translation' => 'mswarm-cloud-demo-translator',
        'review' => null,
    ],
]);
$assert($snapshot['assignments']['translation'] === 'mswarm-cloud-demo-translator', 'assignment should round-trip');

$test = $manager->testAgent(['slug' => 'mswarm-cloud-demo-translator']);
$assert($test['ok'] === false, 'local fallback testAgent should fail closed');
$assert(str_contains($test['error'], 'MCODA_AGENT_SETUP_BACKEND_URL'), 'testAgent error should name backend configuration');

$genericToken = GpuJobToken::genericJob([
    'signingSecret' => 'owner-local-signing-secret',
    'nodeId' => 'node-a',
    'jobId' => 'job-a',
    'requestId' => 'request-a',
    'schemaVersion' => '2026-06-14',
    'jobType' => 'cuda.run',
]);
$assert(substr_count($genericToken, '.') === 2, 'generic GPU job token should be JWT-like');

$capabilityToken = GpuJobToken::capability([
    'signingSecret' => 'owner-local-signing-secret',
    'nodeId' => 'node-a',
]);
$assert(substr_count($capabilityToken, '.') === 2, 'GPU capability token should be JWT-like');

$opsToken = GpuJobToken::ops([
    'signingSecret' => 'owner-local-signing-secret',
    'nodeId' => 'node-a',
]);
$assert(substr_count($opsToken, '.') === 2, 'GPU ops token should be JWT-like');

@unlink($storePath);
fwrite(STDOUT, "mcoda laravel agent setup smoke passed\n");
