<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use Mcoda\LaravelAgentSetup\Http\Controllers\McodaAgentSetupController;

Route::middleware(config('mcoda-agent-setup.web_middleware', ['web']))
    ->get(config('mcoda-agent-setup.web_path', 'mcoda-agent-setup'), [McodaAgentSetupController::class, 'page'])
    ->name('mcoda-agent-setup.page');
