<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Facades;

use Illuminate\Support\Facades\Facade;

/**
 * @method static array<string, mixed> fetchSnapshot()
 * @method static array<string, mixed> configureMswarmApiKey(array<string, mixed> $input)
 * @method static array<string, mixed> syncAgents(array<string, mixed> $input = [])
 * @method static array<string, mixed> updateAssignments(array<string, mixed> $input)
 * @method static array<string, mixed> testAgent(array<string, mixed> $input)
 */
final class McodaAgentSetup extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return 'mcoda-agent-setup';
    }
}
