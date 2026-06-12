<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Storage;

use Mcoda\LaravelAgentSetup\Contracts\AgentSetupStore;
use RuntimeException;

final class FileAgentSetupStore implements AgentSetupStore
{
    public function __construct(private readonly string $path)
    {
    }

    /**
     * @return array<string, mixed>
     */
    public function load(): array
    {
        if (! is_file($this->path)) {
            return $this->emptySnapshot();
        }

        $raw = file_get_contents($this->path);
        if ($raw === false || trim($raw) === '') {
            return $this->emptySnapshot();
        }

        $decoded = json_decode($raw, true);
        if (! is_array($decoded)) {
            throw new RuntimeException("Invalid mcoda agent setup store JSON at {$this->path}");
        }

        return array_replace_recursive($this->emptySnapshot(), $decoded);
    }

    /**
     * @param array<string, mixed> $input
     */
    public function saveMswarmKeyMetadata(array $input): void
    {
        $snapshot = $this->load();
        $snapshot['mswarmApiKeyConfigured'] = (bool) ($input['configured'] ?? true);
        $snapshot['mswarmApiKeyLast4'] = $this->nullableString($input['last4'] ?? null);
        $snapshot['mswarmConfiguredAt'] = $this->nullableString($input['configuredAt'] ?? gmdate('c'));
        $snapshot['mswarmConnection'] = is_array($input['connection'] ?? null) ? $input['connection'] : null;
        $snapshot['updatedAt'] = gmdate('c');

        $this->write($snapshot);
    }

    /**
     * @param array<string, string|null> $assignments
     */
    public function saveAssignments(array $assignments): void
    {
        $snapshot = $this->load();
        $cleanAssignments = [];
        foreach ($assignments as $key => $value) {
            if (! is_string($key) || $key === '') {
                continue;
            }
            $cleanAssignments[$key] = is_string($value) && $value !== '' ? $value : null;
        }

        $snapshot['assignments'] = $cleanAssignments;
        $snapshot['updatedAt'] = gmdate('c');

        $this->write($snapshot);
    }

    /**
     * @param array<string, mixed> $snapshot
     */
    private function write(array $snapshot): void
    {
        $directory = dirname($this->path);
        if (! is_dir($directory) && ! mkdir($directory, 0775, true) && ! is_dir($directory)) {
            throw new RuntimeException("Unable to create mcoda agent setup store directory: {$directory}");
        }

        unset($snapshot['mswarmApiKey'], $snapshot['apiKey'], $snapshot['mswarm_api_key']);

        $encoded = json_encode($snapshot, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($encoded === false) {
            throw new RuntimeException('Unable to encode mcoda agent setup store JSON.');
        }

        if (file_put_contents($this->path, $encoded . PHP_EOL, LOCK_EX) === false) {
            throw new RuntimeException("Unable to write mcoda agent setup store: {$this->path}");
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function emptySnapshot(): array
    {
        return [
            'assignments' => [],
            'mswarmApiKeyConfigured' => false,
            'mswarmApiKeyLast4' => null,
            'mswarmConfiguredAt' => null,
            'mswarmConnection' => null,
            'updatedAt' => null,
        ];
    }

    private function nullableString(mixed $value): ?string
    {
        return is_string($value) && $value !== '' ? $value : null;
    }
}
