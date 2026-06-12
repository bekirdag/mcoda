<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;
use Illuminate\View\View;
use Mcoda\LaravelAgentSetup\McodaAgentSetupManager;
use Mcoda\LaravelAgentSetup\Support\RequestPayload;
use Throwable;

final class McodaAgentSetupController extends Controller
{
    public function __construct(private readonly McodaAgentSetupManager $mcoda)
    {
    }

    public function page(): View
    {
        return view('mcoda-agent-setup::setup', [
            'apiBasePath' => url(trim((string) config('mcoda-agent-setup.api_prefix', 'mcoda-agent-setup/api'), '/')),
            'pageTitle' => 'mcoda Agent Setup',
        ]);
    }

    public function snapshot(): JsonResponse
    {
        return response()->json($this->mcoda->fetchSnapshot());
    }

    public function configureApiKey(Request $request): JsonResponse
    {
        $payload = $request->all();

        return $this->jsonResult(fn (): array => $this->mcoda->configureMswarmApiKey([
            'mswarm_api_key' => RequestPayload::apiKey($payload),
            'connection' => RequestPayload::connection($payload),
            'reason_code' => RequestPayload::reasonCode($payload),
            'metadata' => RequestPayload::first($payload, ['metadata']),
        ]));
    }

    public function syncAgents(Request $request): JsonResponse
    {
        $payload = $request->all();

        return $this->jsonResult(fn (): array => $this->mcoda->syncAgents([
            'reason_code' => RequestPayload::reasonCode($payload),
            'metadata' => RequestPayload::first($payload, ['metadata']),
        ]));
    }

    public function updateAssignments(Request $request): JsonResponse
    {
        $payload = $request->all();

        return $this->jsonResult(fn (): array => $this->mcoda->updateAssignments([
            'assignments' => RequestPayload::first($payload, ['assignments'], []),
            'reason_code' => RequestPayload::reasonCode($payload),
            'metadata' => RequestPayload::first($payload, ['metadata']),
        ]));
    }

    public function testAgent(Request $request): JsonResponse
    {
        $payload = $request->all();

        return $this->jsonResult(fn (): array => $this->mcoda->testAgent([
            'slug' => RequestPayload::first($payload, ['slug']),
            'prompt' => RequestPayload::first($payload, ['prompt']),
            'timeout_ms' => RequestPayload::timeoutMs($payload),
        ]));
    }

    /**
     * @param callable(): array<string, mixed> $callback
     */
    private function jsonResult(callable $callback): JsonResponse
    {
        try {
            return response()->json($callback());
        } catch (Throwable $error) {
            return response()->json(['error' => $error->getMessage()], 422);
        }
    }
}
