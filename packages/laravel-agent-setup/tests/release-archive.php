<?php

declare(strict_types=1);

/**
 * Composer archive smoke test for the Packagist-style distribution package.
 *
 * The check builds a local Composer archive in a temporary directory, then
 * verifies that release-critical files and metadata are present while generated
 * validation artifacts stay out of the archive.
 */

$packageRoot = dirname(__DIR__);
$composer = getenv('COMPOSER_BINARY') !== false && trim((string) getenv('COMPOSER_BINARY')) !== ''
    ? (string) getenv('COMPOSER_BINARY')
    : 'composer';
$tempRoot = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR
    . 'mcoda-laravel-agent-setup-archive-' . getmypid() . '-' . bin2hex(random_bytes(4));
$stagingRoot = $tempRoot . '/package';
$keepTemp = getenv('MCODA_RELEASE_ARCHIVE_KEEP') === '1';

try {
    if (! class_exists(ZipArchive::class)) {
        throw new RuntimeException('ZipArchive extension is required for release archive validation');
    }

    mkdir($tempRoot, 0777, true);
    copyPackageToStaging($packageRoot, $stagingRoot);
    createGeneratedArtifactSentinels($stagingRoot);

    runCommand([
        $composer,
        'archive',
        '--format=zip',
        '--dir',
        $tempRoot,
        '--file',
        'mcoda-laravel-agent-setup',
        '--no-interaction',
        '--no-ansi',
    ], $stagingRoot);

    $archivePath = $tempRoot . '/mcoda-laravel-agent-setup.zip';
    assertFileExists($archivePath, 'composer archive should create a zip file');

    $entries = zipEntries($archivePath);
    assertArchiveContains($entries, [
        'LICENSE',
        'README.md',
        'composer.json',
        'config/mcoda-agent-setup.php',
        'resources/views/setup.blade.php',
        'routes/api.php',
        'routes/web.php',
        'src/Client/McodaAgentSetupHttpClient.php',
        'src/Client/McodaGpuJobHttpClient.php',
        'src/Contracts/AgentSetupClient.php',
        'src/Contracts/AgentSetupStore.php',
        'src/Contracts/GpuJobClient.php',
        'src/Facades/McodaAgentSetup.php',
        'src/Facades/McodaGpuJobs.php',
        'src/Http/Controllers/McodaAgentSetupController.php',
        'src/McodaAgentSetupManager.php',
        'src/McodaAgentSetupServiceProvider.php',
        'src/Storage/FileAgentSetupStore.php',
        'src/Support/DefaultStages.php',
        'src/Support/GpuJobToken.php',
        'src/Support/RequestPayload.php',
    ]);
    assertArchiveMissing($entries, 'composer.lock');
    assertArchiveMissing($entries, 'vendor');
    assertArchiveMissing($entries, '.phpunit.cache');
    assertArchiveMissingPrefix($entries, 'vendor/');
    assertArchiveMissingPrefix($entries, '.phpunit.cache/');

    $composerJson = archiveFileContents($archivePath, 'composer.json');
    $metadata = json_decode($composerJson, true);
    if (! is_array($metadata)) {
        throw new RuntimeException('archive composer.json should decode as an array');
    }

    assertComposerMetadata($metadata);

    echo "mcoda laravel agent setup release archive smoke passed\n";
} finally {
    if (! $keepTemp) {
        removeDirectory($tempRoot);
    } else {
        echo "release archive temp directory kept at {$tempRoot}\n";
    }
}

function copyPackageToStaging(string $sourceRoot, string $destinationRoot): void
{
    if (! is_dir($sourceRoot)) {
        throw new RuntimeException("package root does not exist: {$sourceRoot}");
    }

    mkdir($destinationRoot, 0777, true);

    $directory = new RecursiveDirectoryIterator($sourceRoot, FilesystemIterator::SKIP_DOTS);
    $filter = new RecursiveCallbackFilterIterator(
        $directory,
        static function (SplFileInfo $current) use ($sourceRoot): bool {
            $relativePath = substr($current->getPathname(), strlen($sourceRoot) + 1);

            return ! shouldSkipStagingPath($relativePath);
        }
    );
    $iterator = new RecursiveIteratorIterator($filter, RecursiveIteratorIterator::SELF_FIRST);

    foreach ($iterator as $item) {
        if (! $item instanceof SplFileInfo) {
            continue;
        }

        $relativePath = substr($item->getPathname(), strlen($sourceRoot) + 1);
        $targetPath = $destinationRoot . DIRECTORY_SEPARATOR . $relativePath;

        if ($item->isDir()) {
            if (! is_dir($targetPath)) {
                mkdir($targetPath, 0777, true);
            }

            continue;
        }

        $targetDirectory = dirname($targetPath);
        if (! is_dir($targetDirectory)) {
            mkdir($targetDirectory, 0777, true);
        }

        if ($item->isLink()) {
            symlink((string) readlink($item->getPathname()), $targetPath);

            continue;
        }

        copy($item->getPathname(), $targetPath);
    }
}

function shouldSkipStagingPath(string $relativePath): bool
{
    $normalized = str_replace(DIRECTORY_SEPARATOR, '/', $relativePath);
    $firstSegment = explode('/', $normalized, 2)[0] ?? $normalized;

    return $normalized === 'composer.lock'
        || $firstSegment === 'vendor'
        || $firstSegment === '.phpunit.cache';
}

function createGeneratedArtifactSentinels(string $packageRoot): void
{
    createSentinelFile(
        $packageRoot . '/vendor/.mcoda-release-archive-sentinel',
        "release archive vendor sentinel\n"
    );
    createSentinelFile(
        $packageRoot . '/.phpunit.cache/.mcoda-release-archive-sentinel',
        "release archive cache sentinel\n"
    );
    createSentinelFile(
        $packageRoot . '/composer.lock',
        json_encode([
            '_readme' => [
                'Temporary sentinel generated by tests/release-archive.php.',
                'The release archive gate removes this file after validation.',
            ],
            'content-hash' => 'mcoda-release-archive-sentinel',
            'packages' => [],
            'packages-dev' => [],
            'aliases' => [],
            'minimum-stability' => 'stable',
            'stability-flags' => [],
            'prefer-stable' => true,
            'prefer-lowest' => false,
            'platform' => [],
            'platform-dev' => [],
            'plugin-api-version' => '2.0.0',
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL,
    );
}

function createSentinelFile(string $path, string $contents): void
{
    $directory = dirname($path);
    if (! is_dir($directory)) {
        mkdir($directory, 0777, true);
    }

    if (file_exists($path)) {
        return;
    }

    file_put_contents($path, $contents);
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

/**
 * @return list<string>
 */
function zipEntries(string $archivePath): array
{
    $zip = new ZipArchive();
    $result = $zip->open($archivePath);
    if ($result !== true) {
        throw new RuntimeException('failed to open release archive');
    }

    $entries = [];
    for ($index = 0; $index < $zip->numFiles; $index++) {
        $name = $zip->getNameIndex($index);
        if (is_string($name)) {
            $entries[] = $name;
        }
    }

    $zip->close();
    sort($entries);

    return $entries;
}

function archiveFileContents(string $archivePath, string $path): string
{
    $zip = new ZipArchive();
    $result = $zip->open($archivePath);
    if ($result !== true) {
        throw new RuntimeException('failed to open release archive');
    }

    $contents = $zip->getFromName($path);
    $zip->close();
    if (! is_string($contents)) {
        throw new RuntimeException("archive should contain {$path}");
    }

    return $contents;
}

/**
 * @param list<string> $entries
 * @param list<string> $required
 */
function assertArchiveContains(array $entries, array $required): void
{
    foreach ($required as $path) {
        if (! in_array($path, $entries, true)) {
            throw new RuntimeException("release archive should contain {$path}");
        }
    }
}

/**
 * @param list<string> $entries
 */
function assertArchiveMissing(array $entries, string $path): void
{
    if (in_array($path, $entries, true)) {
        throw new RuntimeException("release archive should not contain {$path}");
    }
}

/**
 * @param list<string> $entries
 */
function assertArchiveMissingPrefix(array $entries, string $prefix): void
{
    foreach ($entries as $entry) {
        if (str_starts_with($entry, $prefix)) {
            throw new RuntimeException("release archive should not contain {$entry}");
        }
    }
}

/**
 * @param array<string, mixed> $metadata
 */
function assertComposerMetadata(array $metadata): void
{
    assertSame('mcoda/laravel-agent-setup', $metadata['name'] ?? null, 'archive package name should match');
    assertSame('library', $metadata['type'] ?? null, 'archive package type should be library');
    assertSame('MIT', $metadata['license'] ?? null, 'archive license should be MIT');

    $autoload = $metadata['autoload']['psr-4']['Mcoda\\LaravelAgentSetup\\'] ?? null;
    assertSame('src/', $autoload, 'archive should expose the package PSR-4 autoload mapping');

    $providers = $metadata['extra']['laravel']['providers'] ?? [];
    if (! is_array($providers)) {
        throw new RuntimeException('archive should expose Laravel providers metadata');
    }
    assertContainsStrict(
        'Mcoda\\LaravelAgentSetup\\McodaAgentSetupServiceProvider',
        $providers,
        'archive should expose Laravel service provider auto-discovery metadata'
    );

    $alias = $metadata['extra']['laravel']['aliases']['McodaAgentSetup'] ?? null;
    assertSame(
        'Mcoda\\LaravelAgentSetup\\Facades\\McodaAgentSetup',
        $alias,
        'archive should expose Laravel facade auto-discovery metadata'
    );

    $gpuAlias = $metadata['extra']['laravel']['aliases']['McodaGpuJobs'] ?? null;
    assertSame(
        'Mcoda\\LaravelAgentSetup\\Facades\\McodaGpuJobs',
        $gpuAlias,
        'archive should expose Laravel GPU jobs facade auto-discovery metadata'
    );
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
