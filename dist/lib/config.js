import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_VERSION } from "./version.js";
function resolveConfigDir() {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
    if (process.platform === "win32") {
        return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "CodexRemote");
    }
    if (process.platform === "darwin") {
        return join(home, "Library", "Application Support", "CodexRemote");
    }
    return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "CodexRemote");
}
const CONFIG_DIR = resolveConfigDir();
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
function normalizeConfig(raw) {
    const supabaseUrl = raw.supabaseUrl ?? raw.backendUrl;
    if (!raw.machineId || !supabaseUrl || !raw.supabaseAnonKey) {
        return null;
    }
    return {
        machineId: raw.machineId,
        supabaseUrl,
        supabaseAnonKey: raw.supabaseAnonKey,
        userDisplayName: raw.userDisplayName ?? null,
        createdAt: raw.createdAt ?? new Date().toISOString(),
        lastSeenAt: raw.lastSeenAt ?? new Date().toISOString(),
        cliVersion: CLI_VERSION,
        backendUrl: raw.backendUrl,
    };
}
export function getConfigDir() {
    return CONFIG_DIR;
}
export function getConfigPath() {
    return CONFIG_FILE;
}
export function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
    }
    return CONFIG_DIR;
}
export function configExists() {
    return existsSync(CONFIG_FILE);
}
export function loadConfig() {
    if (!configExists())
        return null;
    try {
        const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
        return normalizeConfig(raw);
    }
    catch {
        return null;
    }
}
export function saveConfig(config) {
    ensureConfigDir();
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}
export function updateConfig(partial) {
    const config = loadConfig();
    if (!config)
        return null;
    const updated = normalizeConfig({
        ...config,
        ...partial,
        lastSeenAt: new Date().toISOString(),
    });
    if (!updated)
        return null;
    saveConfig(updated);
    return updated;
}
//# sourceMappingURL=config.js.map