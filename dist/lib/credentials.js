/**
 * Local credential storage.
 *
 * - Windows: DPAPI-encrypted file bound to the current user.
 * - macOS/Linux: local JSON file restricted to the current user (mode 600).
 *
 * The macOS/Linux fallback is intentionally simple so the CLI remains usable
 * without depending on platform-specific keychain tooling.
 */
import { execSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { ensureConfigDir, getConfigDir } from "./config.js";
function credFile() {
    return join(getConfigDir(), process.platform === "win32" ? "credentials.enc" : "credentials.json");
}
function dpApiEncrypt(plaintext) {
    const ps = [
        "Add-Type -AssemblyName System.Security",
        "$bytes = [System.Text.Encoding]::UTF8.GetBytes($input)",
        "$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')",
        "[Convert]::ToBase64String($enc)",
    ].join("; ");
    return execSync(`powershell -NoProfile -Command "${ps}"`, {
        encoding: "utf-8",
        input: plaintext,
        windowsHide: true,
    }).trim();
}
function dpApiDecrypt(encrypted) {
    const ps = [
        "Add-Type -AssemblyName System.Security",
        `$enc = [Convert]::FromBase64String('${encrypted}')`,
        "$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')",
        "[System.Text.Encoding]::UTF8.GetString($bytes)",
    ].join("; ");
    return execSync(`powershell -NoProfile -Command "${ps}"`, {
        encoding: "utf-8",
        windowsHide: true,
    }).trim();
}
function readCredentialFile() {
    const file = credFile();
    if (!existsSync(file)) {
        return null;
    }
    try {
        return readFileSync(file, "utf-8").trim();
    }
    catch {
        return null;
    }
}
function writeCredentialFile(contents) {
    ensureConfigDir();
    const file = credFile();
    writeFileSync(file, contents, {
        encoding: "utf-8",
        mode: 0o600,
    });
    if (process.platform !== "win32") {
        try {
            chmodSync(file, 0o600);
        }
        catch {
            // Ignore chmod errors on filesystems that do not support POSIX modes.
        }
    }
}
function loadStore() {
    const raw = readCredentialFile();
    if (!raw) {
        return {};
    }
    try {
        if (process.platform === "win32") {
            const json = dpApiDecrypt(raw);
            return JSON.parse(json);
        }
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
function saveStore(store) {
    if (!store.openaiApiKey && !store.authToken) {
        clearCredentials();
        return;
    }
    const json = JSON.stringify(store);
    if (process.platform === "win32") {
        writeCredentialFile(dpApiEncrypt(json));
        return;
    }
    writeCredentialFile(json);
}
function updateStore(mutator) {
    const store = loadStore();
    mutator(store);
    saveStore(store);
}
export function getApiKey() {
    return loadStore().openaiApiKey ?? null;
}
export function setApiKey(key) {
    updateStore((store) => {
        store.openaiApiKey = key;
    });
}
export function clearApiKey() {
    updateStore((store) => {
        delete store.openaiApiKey;
    });
}
export function getAuthToken() {
    return loadStore().authToken ?? null;
}
export function setAuthToken(token) {
    updateStore((store) => {
        store.authToken = token;
    });
}
export function clearAuthToken() {
    updateStore((store) => {
        delete store.authToken;
    });
}
export function hasApiKey() {
    return !!getApiKey();
}
export function hasAuthToken() {
    return !!getAuthToken();
}
export function clearCredentials() {
    const file = credFile();
    if (existsSync(file))
        unlinkSync(file);
}
//# sourceMappingURL=credentials.js.map