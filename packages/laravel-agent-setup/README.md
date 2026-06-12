# mcoda Laravel Agent Setup

Laravel package for embedding the mcoda/mswarm agent setup flow in a Laravel
admin application.

This package mirrors the public `@mcoda/agent-setup` Node SDK backend contract
and provides:

- Laravel service provider auto-discovery
- publishable config
- web and API routes
- a Blade setup UI sample
- a PHP HTTP client for the Node SDK-compatible backend endpoints
- a local file-backed fallback for install smoke tests

## Install

### Current Release Channel

Phase 4 keeps this package as a Composer path repository inside the mcoda
monorepo. Do not publish it independently to Packagist until the coordinated
mcoda SDK release is cut and tagged. That keeps the Laravel package aligned with
the Node `@mcoda/agent-setup` endpoint contract it mirrors.

After a coordinated release, the intended Packagist install command is:

```bash
composer require mcoda/laravel-agent-setup
php artisan vendor:publish --tag=mcoda-agent-setup-config
# Optional, when you want to customize the Blade sample:
php artisan vendor:publish --tag=mcoda-agent-setup-views
```

Until then, add a Composer path repository from a Laravel application:

```json
{
  "repositories": [
    {
      "type": "path",
      "url": "../mcoda/packages/laravel-agent-setup",
      "options": {
        "symlink": true,
        "versions": {
          "mcoda/laravel-agent-setup": "0.1.x-dev"
        }
      }
    }
  ],
  "require": {
    "mcoda/laravel-agent-setup": "0.1.x-dev"
  }
}
```

The explicit `0.1.x-dev` path version keeps Composer resolution deterministic
while the package is unpublished.

Then run:

```bash
composer update mcoda/laravel-agent-setup
php artisan vendor:publish --tag=mcoda-agent-setup-config
# Optional, when you want to customize the Blade sample:
php artisan vendor:publish --tag=mcoda-agent-setup-views
```

## Requirements

- PHP `^8.2`
- Laravel components `^10.0`, `^11.0`, or `^12.0`
- A Laravel admin area where access can be restricted to trusted operators
- A Node SDK-compatible backend when real agent sync/test operations are needed

## Configuration

Set the backend URL when you have a server exposing the Node SDK-compatible
agent setup endpoints:

```dotenv
MCODA_AGENT_SETUP_BACKEND_URL=https://your-app.example.com/api/mcoda
MCODA_AGENT_SETUP_BACKEND_TOKEN=
MCODA_AGENT_SETUP_BACKEND_AUTH_HEADER=Authorization
MCODA_AGENT_SETUP_WEB_PATH=mcoda-agent-setup
MCODA_AGENT_SETUP_API_PREFIX=mcoda-agent-setup/api
MCODA_AGENT_SETUP_WEB_MIDDLEWARE=web,auth
MCODA_AGENT_SETUP_API_MIDDLEWARE=web,auth
MCODA_AGENT_SETUP_HTTP_TIMEOUT=30
MCODA_AGENT_SETUP_STORAGE_PATH=
```

When `MCODA_AGENT_SETUP_BACKEND_URL` is empty, the package runs in local fallback
mode. Fallback mode can render the UI, store non-secret API-key metadata, and
save assignments, but it cannot sync or test real agents.

Config keys:

- `web_path`: path for the Blade setup page.
- `api_prefix`: prefix for the package API routes.
- `web_middleware`: middleware stack for the setup page.
- `api_middleware`: middleware stack for the setup API routes.
- `backend_url`: Node SDK-compatible backend base URL.
- `backend_token`: optional bearer token sent to the backend.
- `backend_auth_header`: header name for the backend token.
- `http_timeout`: backend HTTP timeout in seconds.
- `storage_path`: local fallback JSON store path.
- `stages`: application-specific stage definitions.

## Routes

The package registers:

```text
GET    /mcoda-agent-setup
GET    /mcoda-agent-setup/api/agent-settings
POST   /mcoda-agent-setup/api/mswarm-api-key
POST   /mcoda-agent-setup/api/agents/sync
PATCH  /mcoda-agent-setup/api/agent-settings
POST   /mcoda-agent-setup/api/agents/test
```

The API payload names match the Node SDK contract:

- `mswarm_api_key`
- `connection`
- `reason_code`
- `metadata`
- `assignments`
- `slug`
- `prompt`
- `timeout_ms`

The Laravel routes and manager also normalize the Node handler aliases `apiKey`,
`mswarmApiKey`, `reasonCode`, `timeoutMs`, `mswarm_connection`, and camelCase or
snake_case connection metadata fields before local fallback or remote backend
calls.

## Security

The browser sends a new mswarm API key only to the Laravel backend route. In
fallback mode the package stores only last-four metadata and connection
metadata; it does not persist the full key. In production, configure route
middleware so only authorized admins can access the setup page and API routes.

Production checklist:

- Protect both web and API routes with authentication and an admin authorization
  gate.
- Keep `MCODA_AGENT_SETUP_BACKEND_TOKEN` in environment configuration only.
- Prefer HTTPS for the Laravel app and the backend URL.
- Keep the fallback store path outside any public document root.
- Use Laravel's default CSRF protection for browser-submitted setup requests.
- Treat local fallback mode as setup smoke mode, not a production sync backend.
- Rotate mswarm API keys from the owning product or tenant control plane if an
  operator accidentally submits the wrong key.

## Validation

Run the source-only package checks before consuming or releasing it:

```bash
composer validate --strict
composer run lint
composer run test
composer run smoke
composer run ci
```

The `test` and `smoke` scripts run the same package smoke test. The `ci` script
combines Composer validation, PHP syntax validation, and the smoke test. These
checks do not require committing `vendor/` or `composer.lock` from this library
package.

Run the Laravel runtime integration gate after installing dev dependencies:

```bash
composer install --no-interaction --no-progress --prefer-dist
composer run test:integration
composer run ci:integration
```

The integration gate uses Orchestra Testbench to boot the package inside a
Laravel test application. It verifies service provider bindings, config merge,
facade resolution, web/API route loading, Blade rendering, local fallback API
requests, request alias normalization, assignment persistence, and full API-key
non-persistence.

Run the consumer-install smoke gate when changing Composer metadata, release
docs, or publishable package files:

```bash
composer run test:consumer
composer run ci:consumer
```

The consumer gate creates a temporary Composer project, installs this package
through the documented `0.1.x-dev` path repository flow, builds Laravel package
discovery metadata, and verifies the service provider, facade alias, config file,
Blade view, and documented publish tag mappings are visible to the consuming
project. The temporary project is deleted after the check unless
`MCODA_CONSUMER_SMOKE_KEEP=1` is set.

Run the release archive dry-run before tagging or preparing Packagist
publication. `test:release-archive` remains source-only; `ci:release` is the
combined release gate and should be run after Composer dev dependencies are
installed:

```bash
composer run test:release-archive
composer run ci:release
```

The archive gate stages a temporary copy of the package, creates sentinel
`vendor/`, `composer.lock`, and `.phpunit.cache/` artifacts inside that copy,
builds a Composer zip archive in a temporary directory, inspects the package
metadata and file list, verifies the runtime package surface is present, and
confirms generated validation artifacts are excluded. The live package directory
is not touched; the temporary staging copy and archive are deleted unless
`MCODA_RELEASE_ARCHIVE_KEEP=1` is set.

## Release Readiness

Current Phase 4 decision: keep `mcoda/laravel-agent-setup` as a monorepo path
repository until the coordinated mcoda npm/SDK release is ready. Before
publishing to Packagist later, verify:

- the Node `@mcoda/agent-setup` release is tagged and available
- this README still matches the current endpoint contract
- `composer validate --strict`, `composer run ci`, `composer run ci:release`,
  and the repo test harness pass
- generated validation artifacts such as `vendor/` and `composer.lock` are not
  committed from this library package
- Packagist package metadata points at the tagged monorepo release or split
  package repository selected for distribution
