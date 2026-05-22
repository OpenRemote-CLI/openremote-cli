/**
 * Local credential storage.
 *
 * - Windows: DPAPI-encrypted file bound to the current user.
 * - macOS/Linux: local JSON file restricted to the current user (mode 600).
 *
 * The macOS/Linux fallback is intentionally simple so the CLI remains usable
 * without depending on platform-specific keychain tooling.
 */
export declare function getApiKey(): string | null;
export declare function setApiKey(key: string): void;
export declare function clearApiKey(): void;
export declare function getAuthToken(): string | null;
export declare function setAuthToken(token: string): void;
export declare function clearAuthToken(): void;
export declare function hasApiKey(): boolean;
export declare function hasAuthToken(): boolean;
export declare function clearCredentials(): void;
