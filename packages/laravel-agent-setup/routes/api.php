<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use Mcoda\LaravelAgentSetup\Http\Controllers\McodaAgentSetupController;

Route::middleware(config('mcoda-agent-setup.api_middleware', ['web']))
    ->prefix(config('mcoda-agent-setup.api_prefix', 'mcoda-agent-setup/api'))
    ->name('mcoda-agent-setup.api.')
    ->group(function (): void {
        Route::get('/agent-settings', [McodaAgentSetupController::class, 'snapshot'])->name('snapshot');
        Route::post('/mswarm-api-key', [McodaAgentSetupController::class, 'configureApiKey'])->name('api-key');
        Route::post('/agents/sync', [McodaAgentSetupController::class, 'syncAgents'])->name('sync');
        Route::patch('/agent-settings', [McodaAgentSetupController::class, 'updateAssignments'])->name('assignments');
        Route::post('/agents/test', [McodaAgentSetupController::class, 'testAgent'])->name('test-agent');
    });
