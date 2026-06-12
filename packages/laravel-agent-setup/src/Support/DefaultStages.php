<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Support;

final class DefaultStages
{
    /**
     * @return list<array<string, mixed>>
     */
    public static function all(): array
    {
        return [
            [
                'stageKey' => 'translation',
                'displayName' => 'Translation',
                'description' => "Translate source text into the application's working language.",
                'defaultAgentSlug' => null,
                'recommendedUsage' => 'translation',
                'preferredSource' => 'cloud_or_self_hosted',
                'nullable' => false,
            ],
            [
                'stageKey' => 'summarization',
                'displayName' => 'Summarization',
                'description' => 'Create concise summaries and digests.',
                'defaultAgentSlug' => null,
                'recommendedUsage' => 'summarization',
                'preferredSource' => 'cloud_or_self_hosted',
                'nullable' => false,
            ],
            [
                'stageKey' => 'classification',
                'displayName' => 'Classification',
                'description' => 'Classify text into product-specific categories.',
                'defaultAgentSlug' => null,
                'recommendedUsage' => 'classification',
                'preferredSource' => 'cloud_or_self_hosted',
                'nullable' => false,
            ],
            [
                'stageKey' => 'extraction',
                'displayName' => 'Extraction',
                'description' => 'Extract structured fields from source material.',
                'defaultAgentSlug' => null,
                'recommendedUsage' => 'extraction',
                'preferredSource' => 'cloud_or_self_hosted',
                'nullable' => false,
            ],
            [
                'stageKey' => 'review',
                'displayName' => 'Review',
                'description' => 'Review generated output before product publication or execution.',
                'defaultAgentSlug' => null,
                'recommendedUsage' => 'review',
                'preferredSource' => 'cloud_or_self_hosted',
                'nullable' => true,
            ],
        ];
    }

    /**
     * @param list<array<string, mixed>> $stages
     * @return array<string, string|null>
     */
    public static function assignmentDefaults(array $stages): array
    {
        $assignments = [];
        foreach ($stages as $stage) {
            $key = $stage['stageKey'] ?? null;
            if (! is_string($key) || $key === '') {
                continue;
            }
            $default = $stage['defaultAgentSlug'] ?? null;
            $assignments[$key] = is_string($default) && $default !== '' ? $default : null;
        }

        return $assignments;
    }
}
