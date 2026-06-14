<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Contracts;

interface GpuJobClient
{
    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function listGpus(array $input = []): array;

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function ops(array $input = []): array;

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function uploadArtifact(array $input): array;

    /**
     * @param array<string, mixed> $job
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function create(array $job, array $input = []): array;

    /**
     * @param array<string, mixed> $job
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function runJob(array $job, array $input = []): array;

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function status(array $input): array;

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function logs(array $input): array;

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function events(array $input): array;

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function artifacts(array $input): array;

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function cancel(array $input): array;

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function retry(array $input): array;
}
