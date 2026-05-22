import { EventEmitter } from "node:events";
import type { ProviderRunner, ProviderSessionOptions } from "./provider-runner.js";
import type { RunnerEvents } from "./types.js";
export declare class QwenRunner extends EventEmitter implements ProviderRunner {
    readonly provider: "qwen";
    private sessions;
    on<K extends keyof RunnerEvents>(event: K, fn: RunnerEvents[K]): this;
    emit<K extends keyof RunnerEvents>(event: K, ...args: Parameters<RunnerEvents[K]>): boolean;
    startSession(options: ProviderSessionOptions): void;
    resumeSession(options: ProviderSessionOptions): void;
    respondToSession(sessionId: string, requestId: string, optionIndex: number): {
        ok: boolean;
        error?: string;
    };
    inputToSession(sessionId: string, text: string, modelName?: string, _planMode?: boolean, reasoningEffort?: string, approvalMode?: "full-auto" | "auto-edit" | "suggest", attachments?: string[]): boolean;
    cancelSession(sessionId: string): boolean;
    finishSession(sessionId: string): boolean;
    killAll(): void;
    private launchProcess;
    private buildArgs;
    private mapApprovalMode;
    private normalizeApprovalLine;
    private isApprovalNoiseLine;
    private isApprovalActionLine;
    private isApprovalPromptLine;
    private isExplicitApprovalChoiceLine;
    private isOrdinaryAssistantLine;
    private isTransientStatusText;
    private cleanBoxInnerLine;
    private extractSurroundingBoxLines;
    private extractCodePreviewFromBox;
    private updateLastActionContext;
    private approvalDisplayNeedsActionFallback;
    private extractLatestActionContextFromScreen;
    private preparePromptDetectionLine;
    private buildApprovalDisplay;
    /**
     * Extracts the content of the approval box surrounding the options block.
     * Looks upward from the options lines until a ╭ border is found, and joins
     * the inner lines (stripping "│" borders and excess whitespace). This keeps
     * the tool header (e.g. "?  Edit App.tsx:…") and the diff preview so the
     * mobile approval popup can display what exactly is being asked.
     */
    private extractApprovalBoxContent;
    private parsePrompt;
    private detectGenericApproval;
    private raiseApproval;
    private respondToDetectedApproval;
    private extractApprovalTextParts;
    private emitBlock;
    private flushPendingAssistantText;
    private normalizeTextGrowthCandidate;
    private commonPrefixLength;
    private commonSuffixLength;
    private sharedLeadingWordCount;
    private sharedTrailingWordCount;
    private findPendingTextBlockKey;
    private hasEmittedEquivalentText;
    private setCommandActive;
    private hasActiveCommandPanels;
    /**
     * Parses the current cleaned PTY screen to extract displayable blocks.
     * - Tool calls (Grep/Glob/ReadFile/Shell/Edit/Write) → command/code/path blocks.
     * - Assistant text (lines starting with ✦) → text block (debounced).
     * - Spinner status text (⠋ Looking for a misplaced semicolon…) → thinking block.
     * Deduplicates via signatures stored on the entry.
     */
    private parseScreenBlocks;
    private isTuiNoiseLine;
    private isStandaloneRenderedAssistantLine;
    private collectRenderedAssistantBlocks;
    private isMeaningfulRenderedAssistantBlock;
    /**
     * Collect all ✦-prefixed text blocks from screen lines.
     * Each block starts at a ✦ line and continues with indented continuation lines.
     */
    private collectAssistantBlocks;
    private formatAssistantBlock;
    private stripAnsi;
    private ensureTrace;
    private writeTrace;
    private closeTrace;
}
