<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Contracts;

interface AgentSetupClient
{
    /**
     * @return array<string, mixed>
     */
    public function fetchSnapshot(): array;

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function configureMswarmApiKey(array $input): array;

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function syncAgents(array $input = []): array;

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function updateAssignments(array $input): array;

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function testAgent(array $input): array;
}
