<?php

declare(strict_types=1);

/**
 * Consumer-install smoke test for the unpublished Composer path repository flow.
 *
 * This script creates an isolated temporary Composer project, installs this
 * package through the documented path repository version, builds Laravel's
 * package manifest, and verifies that discovery metadata and publishable assets
 * are available to a consuming Laravel app.
 */

$packageRoot = dirname(__DIR__);
$composer = getenv('COMPOSER_BINARY') !== false && trim((string) getenv('COMPOSER_BINARY')) !== ''
    ? (string) getenv('COMPOSER_BINARY')
    : 'composer';
$tempRoot = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR
    . 'mcoda-laravel-agent-setup-consumer-' . getmypid() . '-' . bin2hex(random_bytes(4));
$keepTemp = getenv('MCODA_CONSUMER_SMOKE_KEEP') === '1';

try {
    mkdir($tempRoot, 0777, true);
    mkdir($tempRoot . '/bootstrap/cache', 0777, true);

    writeJson($tempRoot . '/composer.json', [
        'name' => 'mcoda/laravel-agent-setup-consumer-smoke',
        'type' => 'project',
        'require' => [
            'php' => '^8.2',
            'laravel/framework' => '^10.0|^11.0|^12.0',
            'mcoda/laravel-agent-setup' => '0.1.x-dev',
        ],
        'repositories' => [
            [
                'type' => 'path',
                'url' => $packageRoot,
                'options' => [
                    'symlink' => true,
                    'versions' => [
                        'mcoda/laravel-agent-setup' => '0.1.x-dev',
                    ],
                ],
            ],
        ],
        'minimum-stability' => 'stable',
        'prefer-stable' => true,
    ]);

    runCommand([
        $composer,
        'install',
        '--no-dev',
        '--no-interaction',
        '--no-progress',
        '--prefer-dist',
    ], $tempRoot);

    $autoload = $tempRoot . '/vendor/autoload.php';
    assertFileExists($autoload, 'consumer composer install should generate vendor autoload');
    require $autoload;

    mkdir($tempRoot . '/storage/app', 0777, true);
    $app = new Illuminate\Foundation\Application($tempRoot);
    $app->useStoragePath($tempRoot . '/storage');
    Illuminate\Container\Container::setInstance($app);
    Illuminate\Support\Facades\Facade::setFacadeApplication($app);

    $installedPackagePath = $tempRoot . '/vendor/mcoda/laravel-agent-setup';
    assertFileExists(
        $installedPackagePath . '/composer.json',
        'consumer project should install mcoda/laravel-agent-setup'
    );
    assertComposerInstalledVersion($tempRoot . '/vendor/composer/installed.php');

    $manifestPath = $tempRoot . '/bootstrap/cache/packages.php';
    $manifest = new Illuminate\Foundation\PackageManifest(
        new Illuminate\Filesystem\Filesystem(),
        $tempRoot,
        $manifestPath,
    );
    $manifest->build();

    assertFileExists($manifestPath, 'Laravel package manifest should be built');
    assertContainsStrict(
        Mcoda\LaravelAgentSetup\McodaAgentSetupServiceProvider::class,
        $manifest->providers(),
        'Laravel package manifest should discover the mcoda service provider'
    );

    $aliases = method_exists($manifest, 'aliases') ? $manifest->aliases() : [];
    assertSame(
        Mcoda\LaravelAgentSetup\Facades\McodaAgentSetup::class,
        $aliases['McodaAgentSetup'] ?? null,
        'Laravel package manifest should discover the McodaAgentSetup facade alias'
    );

    $config = require $installedPackagePath . '/config/mcoda-agent-setup.php';
    assertSame(
        'mcoda-agent-setup/api',
        $config['api_prefix'] ?? null,
        'installed package config should expose the default API prefix'
    );
    assertFileExists(
        $installedPackagePath . '/resources/views/setup.blade.php',
        'installed package should include the publishable Blade setup view'
    );
    bootInstalledPackageProvider($app, $config);
    assertPublishPath(
        Mcoda\LaravelAgentSetup\McodaAgentSetupServiceProvider::class,
        'mcoda-agent-setup-config',
        providerSourceDirectory(Mcoda\LaravelAgentSetup\McodaAgentSetupServiceProvider::class)
            . '/../config/mcoda-agent-setup.php',
        $tempRoot . '/config/mcoda-agent-setup.php',
        'installed provider should publish config through the documented tag'
    );
    assertPublishPath(
        Mcoda\LaravelAgentSetup\McodaAgentSetupServiceProvider::class,
        'mcoda-agent-setup-views',
        providerSourceDirectory(Mcoda\LaravelAgentSetup\McodaAgentSetupServiceProvider::class)
            . '/../resources/views',
        $tempRoot . '/resources/views/vendor/mcoda-agent-setup',
        'installed provider should publish views through the documented tag'
    );

    echo "mcoda laravel agent setup consumer install smoke passed\n";
} finally {
    if (! $keepTemp) {
        removeDirectory($tempRoot);
    } else {
        echo "consumer smoke temp project kept at {$tempRoot}\n";
    }
}

/**
 * @param array<string, mixed> $payload
 */
function writeJson(string $path, array $payload): void
{
    $encoded = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if (! is_string($encoded)) {
        throw new RuntimeException('failed to encode consumer composer.json');
    }

    file_put_contents($path, $encoded . PHP_EOL);
}

/**
 * @param list<string> $command
 */
function runCommand(array $command, string $cwd): void
{
    $process = proc_open(
        $command,
        [
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ],
        $pipes,
        $cwd,
    );

    if (! is_resource($process)) {
        throw new RuntimeException('failed to start command: ' . implode(' ', $command));
    }

    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);

    $exitCode = proc_close($process);
    if ($exitCode !== 0) {
        throw new RuntimeException(sprintf(
            "command failed (%s) with exit code %d\nSTDOUT:\n%s\nSTDERR:\n%s",
            implode(' ', $command),
            $exitCode,
            trim(is_string($stdout) ? $stdout : ''),
            trim(is_string($stderr) ? $stderr : ''),
        ));
    }
}

function assertComposerInstalledVersion(string $installedPath): void
{
    assertFileExists($installedPath, 'composer installed metadata should exist');

    $installed = require $installedPath;
    if (! is_array($installed)) {
        throw new RuntimeException('composer installed metadata should be an array');
    }

    $versions = $installed['versions'] ?? [];
    if (! is_array($versions)) {
        throw new RuntimeException('composer installed metadata should include versions');
    }

    $package = $versions['mcoda/laravel-agent-setup'] ?? null;
    if (! is_array($package)) {
        throw new RuntimeException('mcoda/laravel-agent-setup should be present in composer metadata');
    }

    assertSame(
        '0.1.x-dev',
        $package['pretty_version'] ?? null,
        'consumer should resolve the documented 0.1.x-dev path repository version'
    );
}

/**
 * @param array<string, mixed> $config
 */
function bootInstalledPackageProvider(Illuminate\Foundation\Application $app, array $config): void
{
    $app->instance('config', new Illuminate\Config\Repository([
        'mcoda-agent-setup' => $config,
    ]));
    $app->instance('files', new Illuminate\Filesystem\Filesystem());

    $events = new Illuminate\Events\Dispatcher($app);
    $app->instance('events', $events);
    $app->instance(Illuminate\Contracts\Events\Dispatcher::class, $events);

    $router = new Illuminate\Routing\Router($events, $app);
    $app->instance('router', $router);
    $app->instance(Illuminate\Contracts\Routing\Registrar::class, $router);

    $provider = new Mcoda\LaravelAgentSetup\McodaAgentSetupServiceProvider($app);
    $provider->register();
    $provider->boot();
}

function providerSourceDirectory(string $providerClass): string
{
    $fileName = (new ReflectionClass($providerClass))->getFileName();
    if (! is_string($fileName)) {
        throw new RuntimeException('could not resolve provider source path');
    }

    return dirname($fileName);
}

function assertPublishPath(
    string $providerClass,
    string $tag,
    string $source,
    string $target,
    string $message,
): void {
    $publishPaths = Illuminate\Support\ServiceProvider::pathsToPublish($providerClass, $tag);

    assertSame($target, $publishPaths[$source] ?? null, $message);
}

/**
 * @param list<string> $values
 */
function assertContainsStrict(string $needle, array $values, string $message): void
{
    if (! in_array($needle, $values, true)) {
        throw new RuntimeException($message);
    }
}

function assertSame(mixed $expected, mixed $actual, string $message): void
{
    if ($actual !== $expected) {
        throw new RuntimeException($message);
    }
}

function assertFileExists(string $path, string $message): void
{
    if (! file_exists($path)) {
        throw new RuntimeException($message);
    }
}

function removeDirectory(string $path): void
{
    if (! file_exists($path)) {
        return;
    }

    if (is_file($path) || is_link($path)) {
        unlink($path);

        return;
    }

    $items = scandir($path);
    if (! is_array($items)) {
        return;
    }

    foreach ($items as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }

        removeDirectory($path . DIRECTORY_SEPARATOR . $item);
    }

    rmdir($path);
}
