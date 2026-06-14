<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;
use Illuminate\View\View;
use Mcoda\LaravelAgentSetup\Contracts\GpuJobClient;
use Mcoda\LaravelAgentSetup\McodaAgentSetupManager;
use Mcoda\LaravelAgentSetup\Support\RequestPayload;
use RuntimeException;
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

    public function gpuJobOps(Request $request, GpuJobClient $gpuJobs): JsonResponse
    {
        $payload = $request->query();

        return $this->jsonResult(fn (): array => $gpuJobs->ops([
            'auditLimit' => $this->optionalNonNegativeInt(
                RequestPayload::first($payload, ['audit_limit', 'auditLimit']),
                'auditLimit',
            ),
            'auditOffset' => $this->optionalNonNegativeInt(
                RequestPayload::first($payload, ['audit_offset', 'auditOffset']),
                'auditOffset',
            ),
        ]));
    }

    public function gpuJobStatus(Request $request, GpuJobClient $gpuJobs, string $job): JsonResponse
    {
        $payload = $this->gpuJobReference($request->query(), $job);

        return $this->jsonResult(fn (): array => $gpuJobs->status($payload));
    }

    public function gpuJobLogs(Request $request, GpuJobClient $gpuJobs, string $job): JsonResponse
    {
        $payload = $this->gpuJobReference($request->query(), $job);

        return $this->jsonResult(fn (): array => $gpuJobs->logs($payload));
    }

    public function gpuJobEvents(Request $request, GpuJobClient $gpuJobs, string $job): JsonResponse
    {
        $payload = $this->gpuJobReference($request->query(), $job);

        return $this->jsonResult(fn (): array => $gpuJobs->events($payload));
    }

    public function gpuJobArtifacts(Request $request, GpuJobClient $gpuJobs, string $job): JsonResponse
    {
        $payload = $this->gpuJobReference($request->query(), $job);

        return $this->jsonResult(fn (): array => $gpuJobs->artifacts($payload));
    }

    public function cancelGpuJob(Request $request, GpuJobClient $gpuJobs, string $job): JsonResponse
    {
        $payload = $this->gpuJobReference($request->all(), $job);

        return $this->jsonResult(fn (): array => $gpuJobs->cancel($payload));
    }

    public function retryGpuJob(Request $request, GpuJobClient $gpuJobs, string $job): JsonResponse
    {
        $payload = $this->gpuJobReference($request->all(), $job);

        return $this->jsonResult(fn (): array => $gpuJobs->retry($payload));
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

    private function optionalNonNegativeInt(mixed $value, string $label): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (! is_int($value) && ! (is_string($value) && ctype_digit($value))) {
            throw new RuntimeException("{$label} must be a non-negative integer.");
        }
        $integer = (int) $value;
        if ($integer < 0) {
            throw new RuntimeException("{$label} must be a non-negative integer.");
        }

        return $integer;
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    private function gpuJobReference(array $payload, string $job): array
    {
        $reference = [
            'jobId' => $job,
            'requestId' => $this->optionalString(RequestPayload::first($payload, ['requestId', 'request_id'])),
            'schemaVersion' => $this->optionalString(RequestPayload::first($payload, ['schemaVersion', 'schema_version'])),
            'jobType' => $this->optionalString(RequestPayload::first($payload, ['jobType', 'job_type'])),
            'nodeId' => $this->optionalString(RequestPayload::first($payload, ['nodeId', 'node_id'])),
        ];

        return array_filter($reference, static fn (mixed $value): bool => $value !== null);
    }

    private function optionalString(mixed $value): ?string
    {
        return is_string($value) && trim($value) !== '' ? trim($value) : null;
    }
}
