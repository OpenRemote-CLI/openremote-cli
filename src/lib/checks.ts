import { spawnSync } from "node:child_process";
import { configExists, loadConfig } from "./config.js";
import { hasAuthToken } from "./credentials.js";
import type { AgentProvider } from "./types.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function tryExec(cmd: string): string | null {
  try {
    const result = spawnSync(cmd, {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 10_000,
      shell: true,
    });
    if (result.status !== 0) {
      return null;
    }
    return `${result.stdout ?? ""}`.trim();
  } catch {
    return null;
  }
}

function isValidSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function checkNodeVersion(): CheckResult {
  const ver = process.version;
  const major = parseInt(ver.slice(1), 10);
  return {
    name: "Node.js",
    ok: major >= 18,
    detail: major >= 18
      ? `${ver} installed`
      : `${ver} detected - Node.js >= 18 required`,
  };
}

export function checkCodexCli(): CheckResult {
  const ver = tryExec("codex --version");
  if (ver) {
    return { name: "Codex CLI", ok: true, detail: `codex ${ver}` };
  }
  return {
    name: "Codex CLI",
    ok: false,
    detail: "Not found. Install with: npm install -g @openai/codex",
  };
}

export function checkClaudeCodeCli(): CheckResult {
  const ver = tryExec("claude --version");
  if (ver) {
    return { name: "Claude CLI", ok: true, detail: `claude ${ver}` };
  }
  return {
    name: "Claude CLI",
    ok: false,
    detail: "Not found. Install with: npm install -g @anthropic/claude",
  };
}

export function checkQwenCli(): CheckResult {
  const ver = tryExec("qwen --version");
  if (ver) {
    return { name: "Qwen CLI", ok: true, detail: `qwen ${ver}` };
  }
  return {
    name: "Qwen CLI",
    ok: false,
    detail: "Not found. Install with: npm install -g @alibaba-cloud/qwen-cli",
  };
}

export function getSupportedProviders(): AgentProvider[] {
  const supported: AgentProvider[] = [];
  if (checkCodexCli().ok) {
    supported.push("codex");
  }
  if (checkQwenCli().ok) {
    supported.push("qwen");
  }
  if (checkClaudeCodeCli().ok) {
    supported.push("claude");
  }
  return supported;
}

export function checkConfig(): CheckResult {
  if (!configExists()) {
    return {
      name: "Configuration",
      ok: false,
      detail: "No config file. Run: openremote setup",
    };
  }

  const cfg = loadConfig();
  return {
    name: "Configuration",
    ok: !!cfg?.machineId,
    detail: cfg?.machineId
      ? `Machine ID: ${cfg.machineId.slice(0, 8)}...`
      : "Config file corrupt. Run: openremote setup",
  };
}

export function checkAuthToken(): CheckResult {
  const has = hasAuthToken();
  const detail = process.platform === "win32"
    ? "Stored in local encrypted credential store"
    : "Stored in local credential file";
  return {
    name: "Machine Token",
    ok: has,
    detail: has
      ? detail
      : "Not set. Run: openremote login",
  };
}

export function checkSupabaseUrl(): CheckResult {
  const cfg = loadConfig();
  return {
    name: "Supabase URL",
    ok: isValidSupabaseUrl(cfg?.supabaseUrl),
    detail: cfg?.supabaseUrl ?? "Not configured",
  };
}

export function checkSupabaseAnonKey(): CheckResult {
  const cfg = loadConfig();
  const key = cfg?.supabaseAnonKey;
  return {
    name: "Supabase Publishable Key",
    ok: !!key,
    detail: key ? `${key.slice(0, 16)}...` : "Not configured",
  };
}

export function runAllChecks(): CheckResult[] {
  return [
    checkCodexCli(),
    checkClaudeCodeCli(),
    checkQwenCli(),
    checkConfig(),
    checkAuthToken(),
  ];
}
