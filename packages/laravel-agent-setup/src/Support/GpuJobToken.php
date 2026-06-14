<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Support;

use RuntimeException;

final class GpuJobToken
{
    /**
     * @param array<string, mixed> $input
     */
    public static function genericJob(array $input): string
    {
        $secret = self::requireString($input['signingSecret'] ?? $input['signing_secret'] ?? null, 'signingSecret');
        $ttl = self::ttlSeconds($input['tokenTtlSeconds'] ?? $input['token_ttl_seconds'] ?? null);
        $now = time();
        $exp = $now + $ttl;

        return self::sign([
            'node_id' => self::requireString($input['nodeId'] ?? $input['node_id'] ?? null, 'nodeId'),
            'job_id' => self::requireString($input['jobId'] ?? $input['job_id'] ?? null, 'jobId'),
            'request_id' => self::requireString($input['requestId'] ?? $input['request_id'] ?? null, 'requestId'),
            'schema_version' => self::requireString($input['schemaVersion'] ?? $input['schema_version'] ?? null, 'schemaVersion'),
            'job_type' => self::requireString($input['jobType'] ?? $input['job_type'] ?? null, 'jobType'),
            'deadline_at' => gmdate('c', $exp),
            'scope' => 'self_hosted.generic_job.invoke',
            'iat' => $now,
            'exp' => $exp,
        ], $secret);
    }

    /**
     * @param array<string, mixed> $input
     */
    public static function capability(array $input): string
    {
        $secret = self::requireString($input['signingSecret'] ?? $input['signing_secret'] ?? null, 'signingSecret');
        $ttl = self::ttlSeconds($input['tokenTtlSeconds'] ?? $input['token_ttl_seconds'] ?? null);
        $now = time();
        $exp = $now + $ttl;

        return self::sign([
            'node_id' => self::requireString($input['nodeId'] ?? $input['node_id'] ?? null, 'nodeId'),
            'deadline_at' => gmdate('c', $exp),
            'scope' => 'self_hosted.capabilities.read',
            'iat' => $now,
            'exp' => $exp,
            'nonce' => bin2hex(random_bytes(8)),
        ], $secret);
    }

    /**
     * @param array<string, mixed> $input
     */
    public static function ops(array $input): string
    {
        $secret = self::requireString($input['signingSecret'] ?? $input['signing_secret'] ?? null, 'signingSecret');
        $ttl = self::ttlSeconds($input['tokenTtlSeconds'] ?? $input['token_ttl_seconds'] ?? null);
        $now = time();
        $exp = $now + $ttl;

        return self::sign([
            'node_id' => self::requireString($input['nodeId'] ?? $input['node_id'] ?? null, 'nodeId'),
            'deadline_at' => gmdate('c', $exp),
            'scope' => 'self_hosted.generic_job.ops.read',
            'iat' => $now,
            'exp' => $exp,
            'nonce' => bin2hex(random_bytes(8)),
        ], $secret);
    }

    /**
     * @param array<string, mixed> $payload
     */
    private static function sign(array $payload, string $secret): string
    {
        $header = self::base64Url(json_encode(['alg' => 'HS256', 'typ' => 'JWT'], JSON_THROW_ON_ERROR));
        $body = self::base64Url(json_encode($payload, JSON_THROW_ON_ERROR));
        $input = "{$header}.{$body}";
        $signature = self::base64Url(hash_hmac('sha256', $input, $secret, true));

        return "{$input}.{$signature}";
    }

    private static function base64Url(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private static function ttlSeconds(mixed $value): int
    {
        if ($value === null || $value === '') {
            return 3600;
        }
        if (! is_int($value) && ! (is_string($value) && ctype_digit($value))) {
            throw new RuntimeException('tokenTtlSeconds must be a positive integer.');
        }
        $ttl = (int) $value;
        if ($ttl <= 0) {
            throw new RuntimeException('tokenTtlSeconds must be a positive integer.');
        }

        return $ttl;
    }

    private static function requireString(mixed $value, string $label): string
    {
        if (! is_string($value) || trim($value) === '') {
            throw new RuntimeException("{$label} is required.");
        }

        return trim($value);
    }
}
