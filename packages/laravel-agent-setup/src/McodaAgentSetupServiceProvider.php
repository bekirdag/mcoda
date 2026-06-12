<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup;

use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Support\ServiceProvider;
use Mcoda\LaravelAgentSetup\Client\McodaAgentSetupHttpClient;
use Mcoda\LaravelAgentSetup\Contracts\AgentSetupClient;
use Mcoda\LaravelAgentSetup\Contracts\AgentSetupStore;
use Mcoda\LaravelAgentSetup\Storage\FileAgentSetupStore;

final class McodaAgentSetupServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../config/mcoda-agent-setup.php', 'mcoda-agent-setup');

        $this->app->singleton(McodaAgentSetupHttpClient::class, function ($app): McodaAgentSetupHttpClient {
            $config = $app['config']->get('mcoda-agent-setup', []);

            return new McodaAgentSetupHttpClient(
                $app->make(HttpFactory::class),
                $config['backend_url'] ?? null,
                $config['backend_token'] ?? null,
                (string) ($config['backend_auth_header'] ?? 'Authorization'),
                (int) ($config['http_timeout'] ?? 30),
            );
        });

        $this->app->singleton(AgentSetupStore::class, function ($app): AgentSetupStore {
            $path = (string) $app['config']->get('mcoda-agent-setup.storage_path');

            return new FileAgentSetupStore($path);
        });

        $this->app->singleton('mcoda-agent-setup', function ($app): McodaAgentSetupManager {
            return new McodaAgentSetupManager(
                $app->make(McodaAgentSetupHttpClient::class),
                $app->make(AgentSetupStore::class),
                $app['config']->get('mcoda-agent-setup', []),
            );
        });

        $this->app->alias('mcoda-agent-setup', McodaAgentSetupManager::class);
        $this->app->alias('mcoda-agent-setup', AgentSetupClient::class);
    }

    public function boot(): void
    {
        $this->loadViewsFrom(__DIR__ . '/../resources/views', 'mcoda-agent-setup');

        if (! $this->app->routesAreCached()) {
            $this->loadRoutesFrom(__DIR__ . '/../routes/web.php');
            $this->loadRoutesFrom(__DIR__ . '/../routes/api.php');
        }

        $this->publishes([
            __DIR__ . '/../config/mcoda-agent-setup.php' => config_path('mcoda-agent-setup.php'),
        ], 'mcoda-agent-setup-config');

        $this->publishes([
            __DIR__ . '/../resources/views' => resource_path('views/vendor/mcoda-agent-setup'),
        ], 'mcoda-agent-setup-views');
    }
}
