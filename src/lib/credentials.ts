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
import {
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensureConfigDir, getConfigDir } from "./config.js";

interface CredentialStore {
  openaiApiKey?: string;
  authToken?: string;
}

function credFile(): string {
  return join(
    getConfigDir(),
    process.platform === "win32" ? "credentials.enc" : "credentials.json",
  );
}

function dpApiEncrypt(plaintext: string): string {
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

function dpApiDecrypt(encrypted: string): string {
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

function readCredentialFile(): string | null {
  const file = credFile();
  if (!existsSync(file)) {
    return null;
  }
  try {
    return readFileSync(file, "utf-8").trim();
  } catch {
    return null;
  }
}

function writeCredentialFile(contents: string): void {
  ensureConfigDir();
  const file = credFile();
  writeFileSync(file, contents, {
    encoding: "utf-8",
    mode: 0o600,
  });

  if (process.platform !== "win32") {
    try {
      chmodSync(file, 0o600);
    } catch {
      // Ignore chmod errors on filesystems that do not support POSIX modes.
    }
  }
}

function loadStore(): CredentialStore {
  const raw = readCredentialFile();
  if (!raw) {
    return {};
  }

  try {
    if (process.platform === "win32") {
      const json = dpApiDecrypt(raw);
      return JSON.parse(json) as CredentialStore;
    }
    return JSON.parse(raw) as CredentialStore;
  } catch {
    return {};
  }
}

function saveStore(store: CredentialStore): void {
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

function updateStore(mutator: (store: CredentialStore) => void): void {
  const store = loadStore();
  mutator(store);
  saveStore(store);
}

export function getApiKey(): string | null {
  return loadStore().openaiApiKey ?? null;
}

export function setApiKey(key: string): void {
  updateStore((store) => {
    store.openaiApiKey = key;
  });
}

export function clearApiKey(): void {
  updateStore((store) => {
    delete store.openaiApiKey;
  });
}

export function getAuthToken(): string | null {
  return loadStore().authToken ?? null;
}

export function setAuthToken(token: string): void {
  updateStore((store) => {
    store.authToken = token;
  });
}

export function clearAuthToken(): void {
  updateStore((store) => {
    delete store.authToken;
  });
}

export function hasApiKey(): boolean {
  return !!getApiKey();
}

export function hasAuthToken(): boolean {
  return !!getAuthToken();
}

export function clearCredentials(): void {
  const file = credFile();
  if (existsSync(file)) unlinkSync(file);
}
