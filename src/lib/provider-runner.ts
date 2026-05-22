import type { AgentProvider, RunnerEvents } from "./types.js";

export interface ProviderSessionOptions {
  sessionId: string;
  projectPath: string;
  prompt: string;
  modelName: string;
  reasoningEffort: string;
  approvalMode: "full-auto" | "auto-edit" | "suggest";
  planMode: boolean;
  apiKey?: string;
  providerSessionId?: string | null;
  timeoutMs?: number;
  attachments?: string[];
}

export interface ProviderRunner {
  readonly provider: AgentProvider;
  on<K extends keyof RunnerEvents>(event: K, fn: RunnerEvents[K]): this;
  startSession(options: ProviderSessionOptions): void;
  resumeSession(options: ProviderSessionOptions): void;
  respondToSession(
    sessionId: string,
    requestId: string,
    optionIndex: number,
  ): { ok: boolean; error?: string };
  inputToSession(
    sessionId: string,
    text: string,
    modelName?: string,
    planMode?: boolean,
    reasoningEffort?: string,
    approvalMode?: "full-auto" | "auto-edit" | "suggest",
    attachments?: string[],
  ): boolean;
  cancelSession(sessionId: string): boolean;
  finishSession(sessionId: string): boolean;
  killAll(): void;
}
