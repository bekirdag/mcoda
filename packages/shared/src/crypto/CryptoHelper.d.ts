export declare class CryptoHelper {
    private static loadOrCreateKey;
    /**
     * Encrypts a plaintext payload using AES-256-GCM and returns a base64 blob
     * that contains IV + auth tag + ciphertext. The encryption key is stored
     * under ~/.mcoda/ with user-only permissions.
     */
    static encryptSecret(plaintext: string): Promise<string>;
    /**
     * Decrypts a secret previously produced by encryptSecret. Throws if the
     * payload is malformed or the authentication tag does not validate.
     */
    static decryptSecret(payload: string): Promise<string>;
}
//# sourceMappingURL=CryptoHelper.d.ts.map