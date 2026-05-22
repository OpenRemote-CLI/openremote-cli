import type { AgentProvider } from "./types.js";
export interface CheckResult {
    name: string;
    ok: boolean;
    detail: string;
}
export declare function checkNodeVersion(): CheckResult;
export declare function checkCodexCli(): CheckResult;
export declare function checkClaudeCodeCli(): CheckResult;
export declare function checkQwenCli(): CheckResult;
export declare function getSupportedProviders(): AgentProvider[];
export declare function checkConfig(): CheckResult;
export declare function checkAuthToken(): CheckResult;
export declare function checkSupabaseUrl(): CheckResult;
export declare function checkSupabaseAnonKey(): CheckResult;
export declare function runAllChecks(): CheckResult[];
