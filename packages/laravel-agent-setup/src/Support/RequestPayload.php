<?php

declare(strict_types=1);

namespace Mcoda\LaravelAgentSetup\Support;

final class RequestPayload
{
    /**
     * @param array<string, mixed> $payload
     * @param list<string> $keys
     */
    public static function first(array $payload, array $keys, mixed $default = null): mixed
    {
        foreach ($keys as $key) {
            if (array_key_exists($key, $payload)) {
                return $payload[$key];
            }
        }

        return $default;
    }

    /**
     * @param array<string, mixed> $payload
     */
    public static function apiKey(array $payload): ?string
    {
        return self::nonEmptyString(self::first($payload, ['mswarm_api_key', 'mswarmApiKey', 'apiKey']));
    }

    /**
     * @param array<string, mixed> $payload
     */
    public static function reasonCode(array $payload): ?string
    {
        return self::nonEmptyString(self::first($payload, ['reason_code', 'reasonCode']));
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>|null
     */
    public static function connection(array $payload): ?array
    {
        $explicit = self::first($payload, ['connection', 'mswarm_connection']);
        if (is_array($explicit)) {
            /** @var array<string, mixed> $explicit */
            return $explicit;
        }

        $connection = [];
        foreach ([
            'tenantId' => ['tenantId', 'tenant_id'],
            'productSlug' => ['productSlug', 'product_slug'],
            'apiKeyId' => ['apiKeyId', 'api_key_id'],
            'ownerUserId' => ['ownerUserId', 'owner_user_id'],
            'ownerKeycloakUserId' => ['ownerKeycloakUserId', 'owner_keycloak_user_id'],
            'featureKey' => ['featureKey', 'feature_key'],
            'installationId' => ['installationId', 'installation_id'],
            'installationStatus' => ['installationStatus', 'installation_status'],
            'validationMode' => ['validationMode', 'validation_mode'],
        ] as $target => $keys) {
            $value = self::nonEmptyString(self::first($payload, $keys));
            if ($value !== null) {
                $connection[$target] = $value;
            }
        }

        return $connection === [] ? null : $connection;
    }

    /**
     * @param array<string, mixed> $payload
     */
    public static function timeoutMs(array $payload): int|float|null
    {
        $value = self::first($payload, ['timeout_ms', 'timeoutMs']);

        return (is_int($value) || is_float($value)) && is_finite($value) ? $value : null;
    }

    private static function nonEmptyString(mixed $value): ?string
    {
        return is_string($value) && trim($value) !== '' ? $value : null;
    }
}
