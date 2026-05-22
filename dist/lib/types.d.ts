export interface AppConfig {
    machineId: string;
    supabaseUrl: string;
    supabaseAnonKey: string;
    userDisplayName: string | null;
    createdAt: string;
    lastSeenAt: string;
    cliVersion: string;
    backendUrl?: string;
}
export type MachineAvailabilityState = "offline" | "idle" | "busy" | "revoked";
export type AgentProvider = "codex" | "qwen" | "claude";
export type SessionStatus = "queued" | "running" | "idle" | "completed" | "failed" | "cancelled";
export interface ParsedOption {
    index: number;
    label: string;
    shortcutKey: string | null;
    description?: string;
}
export interface MachineHelloMsg {
    type: "machine:hello";
    payload: {
        machineId: string;
        authToken: string;
    };
}
export interface MachineOfflineMsg {
    type: "machine:offline";
    payload: {
        machineId: string;
    };
}
export interface SessionOutputMsg {
    type: "session:output";
    payload: {
        sessionId: string;
        data: string;
        timestamp: number;
    };
}
export interface SessionStatusMsg {
    type: "session:status";
    payload: {
        sessionId: string;
        status: SessionStatus;
    };
}
export interface SessionApprovalMsg {
    type: "session:approval";
    payload: {
        sessionId: string;
        requestId: string;
        title?: string;
        provider: AgentProvider;
        message: string;
        kind?: "permission" | "ask";
        options: {
            label: string;
            index: number;
            description?: string;
        }[];
    };
}
export interface SessionCompleteMsg {
    type: "session:complete";
    payload: {
        sessionId: string;
        exitCode: number;
        duration: number;
    };
}
export interface SessionErrorMsg {
    type: "session:error";
    payload: {
        sessionId: string;
        error: string;
    };
}
export interface SessionBusyMsg {
    type: "session:busy";
    payload: {
        sessionId: string;
    };
}
export interface SessionMetaMsg {
    type: "session:meta";
    payload: {
        sessionId: string;
        providerSessionId: string;
    };
}
export interface SessionReadableBlockMsg {
    type: "session:block";
    payload: {
        sessionId: string;
        block: Omit<SessionReadableBlockIngest, "seq" | "occurredAt"> & {
            seq?: number;
            occurredAt?: string;
        };
    };
}
export type OutboundMessage = MachineHelloMsg | MachineOfflineMsg | SessionOutputMsg | SessionStatusMsg | SessionApprovalMsg | SessionCompleteMsg | SessionErrorMsg | SessionBusyMsg | SessionMetaMsg | SessionReadableBlockMsg;
export interface MachineReadyMsg {
    type: "machine:ready";
    payload: Record<string, never>;
}
export interface SessionStartMsg {
    type: "session:start";
    payload: {
        sessionId: string;
        provider: AgentProvider;
        prompt: string;
        modelName: string;
        reasoningEffort: string;
        projectPath: string;
        approvalMode: "full-auto" | "auto-edit" | "suggest";
        planMode: boolean;
        forceReplace?: boolean;
        attachments?: AttachmentRef[];
    };
}
export interface AttachmentRef {
    url: string;
    name: string;
}
export interface SessionCancelMsg {
    type: "session:cancel";
    payload: {
        sessionId: string;
    };
}
export interface SessionRespondMsg {
    type: "session:respond";
    payload: {
        sessionId: string;
        requestId: string;
        optionIndex: number;
    };
}
export interface SessionInputMsg {
    type: "session:input";
    payload: {
        sessionId: string;
        text: string;
        provider?: AgentProvider;
        modelName?: string;
        planMode?: boolean;
        reasoningEffort?: string;
        projectPath?: string;
        approvalMode?: "full-auto" | "auto-edit" | "suggest";
        providerSessionId?: string | null;
        forceReplace?: boolean;
        attachments?: AttachmentRef[];
    };
}
export interface SessionFinishMsg {
    type: "session:finish";
    payload: {
        sessionId: string;
    };
}
export type InboundMessage = MachineReadyMsg | SessionStartMsg | SessionCancelMsg | SessionRespondMsg | SessionInputMsg | SessionFinishMsg;
export interface SessionIngestEvent {
    seq: number;
    eventType: string;
    payload: Record<string, unknown>;
    occurredAt: string;
}
export interface SessionIngestOutputSegment {
    seq: number;
    text: string;
    byteCount: number;
    occurredAt: string;
}
export type SessionReadableBlockKind = "thinking" | "command" | "output" | "text" | "code" | "path" | "error" | "status";
export interface SessionReadableBlockIngest {
    seq?: number;
    kind: SessionReadableBlockKind;
    title?: string;
    body: string;
    metadata?: Record<string, unknown>;
    occurredAt: string;
}
export interface SessionPatch {
    status?: SessionStatus;
    exitCode?: number | null;
    durationMs?: number | null;
    completedAt?: string | null;
    providerSessionId?: string | null;
    codexSessionId?: string | null;
}
export interface RunnerEvents {
    output: (sessionId: string, data: string) => void;
    readableBlock: (sessionId: string, block: Omit<SessionReadableBlockIngest, "seq" | "occurredAt"> & {
        seq?: number;
        occurredAt?: string;
    }) => void;
    error: (sessionId: string, error: string) => void;
    status: (sessionId: string, status: SessionStatus) => void;
    complete: (sessionId: string, exitCode: number, duration: number) => void;
    approval: (sessionId: string, requestId: string, title: string | null, message: string, options: ParsedOption[], kind?: "permission" | "ask") => void;
    providerSession: (sessionId: string, providerSessionId: string) => void;
    sessionLog: (sessionId: string, tracePath: string) => void;
}
