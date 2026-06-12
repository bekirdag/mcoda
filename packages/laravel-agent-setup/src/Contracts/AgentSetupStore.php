<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Contracts;

interface AgentSetupStore
{
    /**
     * @return array<string, mixed>
     */
    public function load(): array;

    /**
     * @param array<string, mixed> $input
     */
    public function saveMswarmKeyMetadata(array $input): void;

    /**
     * @param array<string, string|null> $assignments
     */
    public function saveAssignments(array $assignments): void;
}
