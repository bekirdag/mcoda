<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Facades;

use Illuminate\Support\Facades\Facade;

/**
 * @method static array<string, mixed> listGpus(array<string, mixed> $input = [])
 * @method static array<string, mixed> ops(array<string, mixed> $input = [])
 * @method static array<string, mixed> uploadArtifact(array<string, mixed> $input)
 * @method static array<string, mixed> create(array<string, mixed> $job, array<string, mixed> $input = [])
 * @method static array<string, mixed> runJob(array<string, mixed> $job, array<string, mixed> $input = [])
 * @method static array<string, mixed> status(array<string, mixed> $input)
 * @method static array<string, mixed> logs(array<string, mixed> $input)
 * @method static array<string, mixed> events(array<string, mixed> $input)
 * @method static array<string, mixed> artifacts(array<string, mixed> $input)
 * @method static array<string, mixed> cancel(array<string, mixed> $input)
 * @method static array<string, mixed> retry(array<string, mixed> $input)
 */
final class McodaGpuJobs extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return 'mcoda-gpu-jobs';
    }
}
