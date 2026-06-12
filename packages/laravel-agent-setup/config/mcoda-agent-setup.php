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
