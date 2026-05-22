import { EventEmitter } from "node:events";
import type { ProviderRunner, ProviderSessionOptions } from "./provider-runner.js";
export declare class ClaudeRunner extends EventEmitter implements ProviderRunner {
    readonly provider: "claude";
    private readonly sessions;
    startSession(options: ProviderSessionOptions): void;
    resumeSession(options: ProviderSessionOptions): void;
    /**
     * Called when the user responds to a permission approval popup.
     * optionIndex 0 = Allow, 1 = Deny
     */
    respondToSession(sessionId: string, requestId: string, optionIndex: number): {
        ok: boolean;
        error?: string;
    };
    inputToSession(sessionId: string, text: string, modelName?: string, planMode?: boolean, reasoningEffort?: string, approvalMode?: "full-auto" | "auto-edit" | "suggest", attachments?: string[]): boolean;
    cancelSession(sessionId: string): boolean;
    finishSession(sessionId: string): boolean;
    killAll(): void;
    private createEntry;
    private spawnClaude;
    private handleJsonLine;
    private handleSystemEvent;
    private handleAssistantEvent;
    /**
     * For sub-agent events (parent_tool_use_id set): only surface Edit and Write
     * tool calls so the user can see which files were actually modified. All
     * other blocks (text, thinking, Bash, Read, Glob, …) are suppressed.
     */
    private handleSubAgentAssistantEvent;
    private handleToolUseBlock;
    private handleUserEvent;
    private handleResultEvent;
    private raisePermissionApproval;
    private emitBlock;
    private setStatus;
    private finalizeSession;
    private killProcess;
    private traceEvent;
}
