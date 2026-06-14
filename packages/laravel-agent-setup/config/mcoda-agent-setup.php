<?php

declare(strict_types=1);

use Mcoda\LaravelAgentSetup\Support\DefaultStages;

$storagePath = function_exists('storage_path')
    ? storage_path('app/mcoda-agent-setup/settings.json')
    : __DIR__ . '/../storage/mcoda-agent-setup/settings.json';

$middleware = static function (string $key, array $default): array {
    $raw = env($key);
    if (! is_string($raw) || trim($raw) === '') {
        return $default;
    }

    return array_values(array_filter(
        array_map(static fn (string $entry): string => trim($entry), explode(',', $raw)),
        static fn (string $entry): bool => $entry !== '',
    ));
};

return [
    /*
    |--------------------------------------------------------------------------
    | Routes
    |--------------------------------------------------------------------------
    |
    | The web route renders a simple Blade setup UI. The API routes mirror the
    | @mcoda/agent-setup Node SDK endpoint contract.
    |
    */
    'web_path' => env('MCODA_AGENT_SETUP_WEB_PATH', 'mcoda-agent-setup'),
    'api_prefix' => env('MCODA_AGENT_SETUP_API_PREFIX', 'mcoda-agent-setup/api'),
    'web_middleware' => $middleware('MCODA_AGENT_SETUP_WEB_MIDDLEWARE', ['web']),
    'api_middleware' => $middleware('MCODA_AGENT_SETUP_API_MIDDLEWARE', ['web']),

    /*
    |--------------------------------------------------------------------------
    | Remote Backend
    |--------------------------------------------------------------------------
    |
    | Point this at an existing backend that exposes the @mcoda/agent-setup
    | server endpoints. When it is empty, the package uses local fallback mode.
    |
    */
    'backend_url' => env('MCODA_AGENT_SETUP_BACKEND_URL'),
    'backend_token' => env('MCODA_AGENT_SETUP_BACKEND_TOKEN'),
    'backend_auth_header' => env('MCODA_AGENT_SETUP_BACKEND_AUTH_HEADER', 'Authorization'),
    'http_timeout' => (int) env('MCODA_AGENT_SETUP_HTTP_TIMEOUT', 30),

    /*
    |--------------------------------------------------------------------------
    | Owner-Local GPU Job Node
    |--------------------------------------------------------------------------
    |
    | These settings are used by the GPU job client. The client talks directly
    | to the owner-local mswarm self-hosted node control plane and signs scoped
    | short-lived tokens with the node invocation signing secret when a prebuilt
    | token is not supplied.
    |
    */
    'gpu_job_node_base_url' => env('MCODA_GPU_JOB_NODE_BASE_URL', 'http://127.0.0.1:18488'),
    'gpu_job_node_id' => env('MCODA_GPU_JOB_NODE_ID'),
    'gpu_job_signing_secret' => env('MCODA_GPU_JOB_SIGNING_SECRET'),
    'gpu_job_token' => env('MCODA_GPU_JOB_TOKEN'),
    'gpu_job_ops_token' => env('MCODA_GPU_JOB_OPS_TOKEN'),
    'gpu_job_token_ttl_seconds' => (int) env('MCODA_GPU_JOB_TOKEN_TTL_SECONDS', 3600),
    'gpu_job_timeout_seconds' => (int) env('MCODA_GPU_JOB_TIMEOUT_SECONDS', 30),

    /*
    |--------------------------------------------------------------------------
    | Local Fallback Store
    |--------------------------------------------------------------------------
    |
    | The fallback store persists assignments and non-secret mswarm key metadata.
    | It never persists the full API key.
    |
    */
    'storage_path' => env('MCODA_AGENT_SETUP_STORAGE_PATH', $storagePath),

    /*
    |--------------------------------------------------------------------------
    | Stage Defaults
    |--------------------------------------------------------------------------
    |
    | Consumers may replace this list with application-specific stages.
    |
    */
    'stages' => DefaultStages::all(),
];
