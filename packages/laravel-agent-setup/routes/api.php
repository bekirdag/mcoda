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
        Route::get('/gpu-jobs/ops', [McodaAgentSetupController::class, 'gpuJobOps'])->name('gpu-jobs.ops');
        Route::get('/gpu-jobs/{job}', [McodaAgentSetupController::class, 'gpuJobStatus'])->name('gpu-jobs.status');
        Route::get('/gpu-jobs/{job}/logs', [McodaAgentSetupController::class, 'gpuJobLogs'])->name('gpu-jobs.logs');
        Route::get('/gpu-jobs/{job}/events', [McodaAgentSetupController::class, 'gpuJobEvents'])->name('gpu-jobs.events');
        Route::get('/gpu-jobs/{job}/artifacts', [McodaAgentSetupController::class, 'gpuJobArtifacts'])->name('gpu-jobs.artifacts');
        Route::post('/gpu-jobs/{job}/cancel', [McodaAgentSetupController::class, 'cancelGpuJob'])->name('gpu-jobs.cancel');
        Route::post('/gpu-jobs/{job}/retry', [McodaAgentSetupController::class, 'retryGpuJob'])->name('gpu-jobs.retry');
    });
