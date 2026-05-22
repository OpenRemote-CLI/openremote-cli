import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { findCodexSessionIdForProject } from "./codex-session-store.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { log } from "./logger.js";
function ts() {
    return `[${new Date().toISOString()}] [runner]`;
}
function stringifyError(error) {
    return error instanceof Error ? error.message : String(error);
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function asString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function summarizeCommandFailure(output, exitCode) {
    const firstMeaningfulLine = (output ?? "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !/^exit code:/i.test(line) && !/^wall time:/i.test(line));
    const base = typeof exitCode === "number"
        ? `Une commande a échoué (exit code ${exitCode}).`
        : "Une commande a échoué.";
    if (!firstMeaningfulLine) {
        return base;
    }
    return `${base} ${firstMeaningfulLine}`.slice(0, 320);
}
function buildTextInput(text) {
    return [
        {
            type: "text",
            text,
            text_elements: [],
        },
    ];
}
function mapApprovalPolicy(approvalMode) {
    void approvalMode;
    return "on-request";
}
function mapSandboxMode(approvalMode) {
    return approvalMode === "full-auto" || approvalMode === "auto-edit"
        ? "workspace-write"
        : undefined;
}
function buildThreadConfig(entry) {
    const config = {
        cwd: entry.projectPath,
        model: entry.modelName,
        approvalPolicy: mapApprovalPolicy(entry.approvalMode),
        experimentalRawEvents: true,
        persistExtendedHistory: true,
    };
    const sandbox = mapSandboxMode(entry.approvalMode);
    if (sandbox) {
        config.sandbox = sandbox;
    }
    return config;
}
function buildTurnConfig(entry) {
    return {
        threadId: entry.providerSessionId,
        input: buildTextInput(entry.prompt),
        model: entry.modelName,
        effort: entry.reasoningEffort,
        approvalPolicy: mapApprovalPolicy(entry.approvalMode),
    };
}
export class CodexRunner extends EventEmitter {
    provider = "codex";
    client = new CodexAppServerClient();
    sessions = new Map();
    sessionByThreadId = new Map();
    constructor() {
        super();
        this.client.on("notification", (method, params) => {
            this.handleNotification(method, params);
        });
        this.client.on("serverRequest", (id, method, params) => {
            this.handleServerRequest(id, method, params);
        });
        this.client.on("closed", (reason) => {
            this.handleClientClosed(reason);
        });
    }
    on(event, fn) {
        return super.on(event, fn);
    }
    emit(event, ...args) {
        return super.emit(event, ...args);
    }
    startSession(options) {
        const entry = this.createSessionEntry(options, "queued");
        this.ensureTrace(entry);
        this.sessions.set(entry.id, entry);
        void this.openThread(entry, false);
    }
    resumeSession(options) {
        const entry = this.createSessionEntry(options, "queued");
        this.ensureTrace(entry);
        this.sessions.set(entry.id, entry);
        void this.openThread(entry, true);
    }
    respondToSession(sessionId, requestId, optionIndex) {
        const entry = this.sessions.get(sessionId);
        if (!entry) {
            return {
                ok: false,
                error: "Approval could not be resolved because the session is no longer active.",
            };
        }
        const pending = entry.pendingApprovals.get(requestId);
        if (!pending) {
            return {
                ok: false,
                error: "Approval could not be resolved because there is no pending request.",
            };
        }
        const option = pending.options[optionIndex];
        if (!option) {
            return {
                ok: false,
                error: "Approval could not be resolved because the selected option is invalid.",
            };
        }
        entry.pendingApprovals.delete(requestId);
        this.writeTrace(entry, "approval-response", {
            requestId,
            optionIndex,
            label: option.label,
        });
        void pending
            .respond(optionIndex)
            .then(() => {
            if (this.sessions.has(sessionId) && entry.pendingApprovals.size === 0) {
                this.setStatus(entry, "running");
            }
        })
            .catch((error) => {
            this.handleTurnFailure(entry, `Failed to respond to Codex approval request: ${stringifyError(error)}`);
        });
        return { ok: true };
    }
    inputToSession(sessionId, text, modelName, planMode, reasoningEffort, approvalMode, _attachments) {
        const entry = this.sessions.get(sessionId);
        if (!entry || !entry.providerSessionId) {
            return false;
        }
        if (entry.activeTurnId || entry.status === "running") {
            this.emit("error", sessionId, "Codex is already working on this session. Wait for the current turn to finish.");
            return false;
        }
        entry.prompt = text;
        if (modelName) {
            entry.modelName = modelName;
        }
        if (typeof planMode === "boolean") {
            entry.planMode = planMode;
        }
        if (reasoningEffort) {
            entry.reasoningEffort = reasoningEffort;
        }
        if (approvalMode) {
            entry.approvalMode = approvalMode;
        }
        entry.pendingApprovals.clear();
        entry.seenDeltaItems.clear();
        this.setStatus(entry, "running");
        void this.startTurn(entry);
        return true;
    }
    cancelSession(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry) {
            return false;
        }
        this.writeTrace(entry, "session-cancel-requested", {
            activeTurnId: entry.activeTurnId,
            providerSessionId: entry.providerSessionId,
        });
        const activeTurnId = entry.activeTurnId;
        entry.activeTurnId = null;
        if (entry.providerSessionId && activeTurnId) {
            void this.client
                .request("turn/interrupt", {
                threadId: entry.providerSessionId,
                turnId: activeTurnId,
            })
                .catch((error) => {
                log.debug(`${ts()} session ${sessionId} - interrupt failed: ${stringifyError(error)}`);
            });
        }
        this.finalizeSession(entry, "cancelled", 130);
        return true;
    }
    finishSession(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry) {
            return false;
        }
        this.writeTrace(entry, "session-finish-requested", {
            providerSessionId: entry.providerSessionId,
        });
        if (entry.providerSessionId) {
            void this.client
                .request("thread/unsubscribe", {
                threadId: entry.providerSessionId,
            })
                .catch((error) => {
                log.debug(`${ts()} session ${sessionId} - unsubscribe failed: ${stringifyError(error)}`);
            });
        }
        this.finalizeSession(entry, "completed", 0);
        return true;
    }
    killAll() {
        for (const [sessionId, entry] of Array.from(this.sessions.entries())) {
            if (entry.status === "running" || entry.status === "queued" || entry.activeTurnId !== null) {
                this.cancelSession(sessionId);
            }
            else {
                // Idle session — clean up resources without marking it cancelled in the DB.
                if (entry.timeout) {
                    clearTimeout(entry.timeout);
                    entry.timeout = null;
                }
                this.closeTrace(entry);
                this.sessions.delete(sessionId);
            }
        }
        void this.client.stop();
    }
    createSessionEntry(options, status) {
        const timeout = options.timeoutMs && options.timeoutMs > 0
            ? setTimeout(() => {
                this.cancelSession(options.sessionId);
            }, options.timeoutMs)
            : null;
        return {
            id: options.sessionId,
            prompt: options.prompt,
            modelName: options.modelName,
            reasoningEffort: options.reasoningEffort,
            projectPath: options.projectPath,
            approvalMode: options.approvalMode,
            planMode: options.planMode,
            status,
            startedAt: Date.now(),
            apiKey: options.apiKey ?? "",
            providerSessionId: options.providerSessionId ?? null,
            activeTurnId: null,
            timeout,
            pendingApprovals: new Map(),
            seenDeltaItems: new Set(),
            reasoningActive: false,
            commandRunning: 0,
            pendingDiff: null,
            lastEmittedDiff: null,
            ptyTracePath: null,
            ptyTraceStream: null,
        };
    }
    async openThread(entry, resume) {
        this.writeTrace(entry, "app-server-bootstrap", {
            resume,
            providerSessionId: entry.providerSessionId,
            projectPath: entry.projectPath,
            model: entry.modelName,
            reasoningEffort: entry.reasoningEffort,
            approvalMode: entry.approvalMode,
            planMode: entry.planMode,
        });
        try {
            await this.client.ensureReady(entry.apiKey);
            let threadId = entry.providerSessionId;
            if (resume && !threadId) {
                threadId = findCodexSessionIdForProject(entry.projectPath, entry.startedAt);
                if (threadId) {
                    entry.providerSessionId = threadId;
                    this.writeTrace(entry, "provider-session-discovered", { providerSessionId: threadId });
                }
            }
            const method = resume ? "thread/resume" : "thread/start";
            const params = resume
                ? {
                    threadId,
                    ...buildThreadConfig(entry),
                    persistExtendedHistory: true,
                }
                : buildThreadConfig(entry);
            this.writeTrace(entry, "jsonrpc-request", { method, params });
            const response = await this.client.request(method, params);
            this.writeTrace(entry, "jsonrpc-response", { method, response });
            const thread = isRecord(response.thread) ? response.thread : null;
            const providerSessionId = thread ? asString(thread.id) : null;
            if (!providerSessionId) {
                throw new Error(`Codex ${method} did not return a thread id.`);
            }
            entry.providerSessionId = providerSessionId;
            this.sessionByThreadId.set(providerSessionId, entry.id);
            this.emit("providerSession", entry.id, providerSessionId);
            if (entry.prompt.trim()) {
                this.setStatus(entry, "running");
                await this.startTurn(entry);
                return;
            }
            this.setStatus(entry, "idle");
        }
        catch (error) {
            this.finalizeWithError(entry, `Failed to ${resume ? "resume" : "start"} Codex session: ${stringifyError(error)}`);
        }
    }
    async startTurn(entry) {
        if (!entry.providerSessionId) {
            this.handleTurnFailure(entry, "Missing Codex thread id for this session.");
            return;
        }
        try {
            this.setReasoningActive(entry, false);
            entry.commandRunning = 0;
            entry.pendingDiff = null;
            const method = "turn/start";
            const params = buildTurnConfig(entry);
            this.writeTrace(entry, "jsonrpc-request", { method, params });
            const response = await this.client.request(method, params);
            this.writeTrace(entry, "jsonrpc-response", { method, response });
            const turn = isRecord(response.turn) ? response.turn : null;
            const turnId = turn ? asString(turn.id) : null;
            if (turnId) {
                entry.activeTurnId = turnId;
            }
        }
        catch (error) {
            this.handleTurnFailure(entry, `Failed to start a Codex turn: ${stringifyError(error)}`);
        }
    }
    handleNotification(method, params) {
        const threadId = params ? asString(params.threadId) : null;
        const entry = threadId ? this.getSessionByThreadId(threadId) : null;
        if (entry) {
            this.writeTrace(entry, "notification", { method, params: params ?? null });
        }
        switch (method) {
            case "turn/started": {
                if (!entry || !params)
                    return;
                const turn = isRecord(params.turn) ? params.turn : null;
                const turnId = turn ? asString(turn.id) : null;
                if (turnId) {
                    entry.activeTurnId = turnId;
                }
                this.setStatus(entry, "running");
                return;
            }
            case "thread/status/changed": {
                if (!entry || !params)
                    return;
                const status = isRecord(params.status) ? asString(params.status.type) : null;
                if (status === "active") {
                    if (entry.pendingApprovals.size === 0) {
                        this.setStatus(entry, "running");
                    }
                    return;
                }
                if (status === "idle") {
                    entry.activeTurnId = null;
                    if (entry.pendingApprovals.size === 0) {
                        this.setStatus(entry, "idle");
                    }
                }
                return;
            }
            case "turn/diff/updated": {
                if (!entry || !params)
                    return;
                const diff = asString(params.diff);
                if (diff) {
                    entry.pendingDiff = diff;
                }
                return;
            }
            case "item/started": {
                if (!entry || !params)
                    return;
                const item = isRecord(params.item) ? params.item : null;
                const itemType = item ? asString(item.type) : null;
                if (!itemType) {
                    return;
                }
                if (itemType === "reasoning") {
                    this.setReasoningActive(entry, true);
                    return;
                }
                if (itemType === "commandExecution") {
                    this.setCommandRunning(entry, true);
                }
                return;
            }
            case "item/agentMessage/delta":
            case "item/commandExecution/outputDelta":
            case "item/fileChange/outputDelta": {
                if (!entry || !params)
                    return;
                const itemId = asString(params.itemId);
                const delta = asString(params.delta);
                if (!delta) {
                    return;
                }
                if (itemId) {
                    entry.seenDeltaItems.add(itemId);
                }
                this.emit("output", entry.id, delta);
                return;
            }
            case "rawResponseItem/completed": {
                if (!entry || !params)
                    return;
                const item = isRecord(params.item) ? params.item : null;
                if (!item) {
                    return;
                }
                const itemType = asString(item.type);
                if (!itemType) {
                    return;
                }
                if (itemType === "reasoning") {
                    this.setReasoningActive(entry, false);
                    return;
                }
                if (itemType !== "message") {
                    return;
                }
                const role = asString(item.role);
                const phase = asString(item.phase);
                if (role !== "assistant" || (phase !== "final_answer" && phase !== "commentary")) {
                    return;
                }
                const content = Array.isArray(item.content) ? item.content : [];
                const text = content
                    .filter((part) => isRecord(part) && part.type === "output_text" && typeof part.text === "string")
                    .map((part) => String(part.text))
                    .join("")
                    .trim();
                if (!text) {
                    return;
                }
                if (phase === "final_answer") {
                    this.clearTransientStates(entry);
                }
                this.emitReadableBlock(entry, {
                    kind: "text",
                    body: text,
                    metadata: {
                        phase,
                    },
                });
                return;
            }
            case "item/completed": {
                if (!entry || !params)
                    return;
                const item = isRecord(params.item) ? params.item : null;
                if (!item) {
                    return;
                }
                const itemId = asString(item.id);
                const itemType = asString(item.type);
                if (!itemId || !itemType || entry.seenDeltaItems.has(itemId)) {
                    return;
                }
                if (itemType === "agentMessage") {
                    const text = asString(item.text);
                    if (text) {
                        this.emit("output", entry.id, text);
                    }
                    return;
                }
                if (itemType === "commandExecution") {
                    this.setCommandRunning(entry, false);
                    const output = asString(item.aggregatedOutput);
                    if (output) {
                        this.emit("output", entry.id, output);
                    }
                    const exitCode = asNumber(item.exitCode);
                    if (exitCode !== null && exitCode !== 0) {
                        this.emitReadableBlock(entry, {
                            kind: "error",
                            title: "Erreur",
                            body: summarizeCommandFailure(output, exitCode),
                            metadata: {
                                source: "command",
                                summary: summarizeCommandFailure(output, exitCode),
                                exitCode,
                            },
                        });
                    }
                    return;
                }
                if (itemType === "reasoning") {
                    this.setReasoningActive(entry, false);
                    return;
                }
                if (itemType === "plan") {
                    const text = asString(item.text);
                    if (text) {
                        this.emit("output", entry.id, text);
                    }
                }
                return;
            }
            case "turn/completed": {
                if (!entry || !params)
                    return;
                const turn = isRecord(params.turn) ? params.turn : null;
                if (!turn) {
                    return;
                }
                const completedTurnId = asString(turn.id);
                if (completedTurnId && entry.activeTurnId === completedTurnId) {
                    entry.activeTurnId = null;
                }
                const status = asString(turn.status);
                if (status === "failed") {
                    this.clearTransientStates(entry);
                    const turnError = isRecord(turn.error) ? asString(turn.error.message) : null;
                    this.handleTurnFailure(entry, turnError ?? "Codex turn failed.");
                    return;
                }
                if (status === "interrupted") {
                    this.clearTransientStates(entry);
                    if (entry.pendingApprovals.size === 0) {
                        this.setStatus(entry, "idle");
                    }
                    return;
                }
                if (status === "completed" && entry.pendingApprovals.size === 0) {
                    this.clearTransientStates(entry);
                    this.emitFinalDiffIfNeeded(entry);
                    this.setStatus(entry, "idle");
                }
                return;
            }
            case "error": {
                if (!entry || !params)
                    return;
                this.clearTransientStates(entry);
                const error = isRecord(params.error) ? asString(params.error.message) : null;
                this.handleTurnFailure(entry, error ?? "Codex reported an error.");
                return;
            }
            default:
                return;
        }
    }
    handleServerRequest(id, method, params) {
        const threadId = params ? asString(params.threadId) : null;
        const entry = threadId ? this.getSessionByThreadId(threadId) : null;
        if (!entry) {
            this.client.respondError(id, `No active OpenRemote session is bound to ${method}.`);
            return;
        }
        this.writeTrace(entry, "server-request", { id, method, params: params ?? null });
        switch (method) {
            case "item/commandExecution/requestApproval":
                this.raiseCommandApproval(entry, id, params);
                return;
            case "item/fileChange/requestApproval":
                this.raiseFileChangeApproval(entry, id, params);
                return;
            case "item/permissions/requestApproval":
                this.raisePermissionApproval(entry, id, params);
                return;
            case "item/tool/requestUserInput":
                this.raiseUserInputRequest(entry, id, params);
                return;
            default:
                this.client.respondError(id, `OpenRemote does not support Codex request ${method}.`);
                this.emit("error", entry.id, `Codex requested unsupported app-server action: ${method}.`);
        }
    }
    raiseCommandApproval(entry, id, params) {
        if (!params) {
            this.client.respondError(id, "Missing approval payload.");
            return;
        }
        const availableDecisions = Array.isArray(params.availableDecisions)
            ? params.availableDecisions
            : ["accept", "decline"];
        const requestId = String(id);
        const options = availableDecisions.map((decision, index) => ({
            index,
            label: this.labelCommandDecision(decision),
            shortcutKey: null,
        }));
        const lines = [
            asString(params.reason) ?? "Codex needs approval before running a command.",
            asString(params.command) ? `Command: ${params.command}` : null,
            asString(params.cwd) ? `Directory: ${params.cwd}` : null,
        ].filter((line) => Boolean(line));
        entry.pendingApprovals.set(requestId, {
            options,
            respond: async (optionIndex) => {
                this.client.respond(id, {
                    decision: availableDecisions[optionIndex],
                });
            },
        });
        this.setStatus(entry, "running");
        this.emit("approval", entry.id, requestId, "Command approval", lines.join("\n"), options);
    }
    raiseFileChangeApproval(entry, id, params) {
        const decisions = ["accept", "acceptForSession", "decline", "cancel"];
        const requestId = String(id);
        const options = decisions.map((decision, index) => ({
            index,
            label: this.labelFileDecision(decision),
            shortcutKey: null,
        }));
        const lines = [
            asString(params?.reason) ?? "Codex needs approval before applying file changes.",
            asString(params?.grantRoot) ? `Requested root: ${params?.grantRoot}` : null,
        ].filter((line) => Boolean(line));
        entry.pendingApprovals.set(requestId, {
            options,
            respond: async (optionIndex) => {
                this.client.respond(id, { decision: decisions[optionIndex] });
            },
        });
        this.setStatus(entry, "running");
        this.emit("approval", entry.id, requestId, "File change approval", lines.join("\n"), options);
    }
    raisePermissionApproval(entry, id, params) {
        const requestId = String(id);
        const options = [
            { index: 0, label: "Allow once", shortcutKey: null },
            { index: 1, label: "Allow for session", shortcutKey: null },
        ];
        const permissions = isRecord(params?.permissions) ? params.permissions : {};
        entry.pendingApprovals.set(requestId, {
            options,
            respond: async (optionIndex) => {
                this.client.respond(id, {
                    permissions: {
                        network: permissions.network ?? undefined,
                        fileSystem: permissions.fileSystem ?? undefined,
                    },
                    scope: optionIndex === 0 ? "turn" : "session",
                });
            },
        });
        const lines = [
            asString(params?.reason) ?? "Codex requested additional permissions.",
            permissions.network ? "Network access requested." : null,
            permissions.fileSystem ? "File system access requested." : null,
        ].filter((line) => Boolean(line));
        this.setStatus(entry, "running");
        this.emit("approval", entry.id, requestId, "Permissions approval", lines.join("\n"), options);
    }
    raiseUserInputRequest(entry, id, params) {
        const questions = Array.isArray(params?.questions) ? params.questions : [];
        const [question] = questions;
        if (!isRecord(question)) {
            this.client.respondError(id, "OpenRemote could not parse Codex user-input questions.");
            this.emit("error", entry.id, "Codex requested interactive input that OpenRemote could not parse.");
            return;
        }
        const optionsSource = Array.isArray(question.options) ? question.options : null;
        const questionId = asString(question.id);
        if (!questionId || !optionsSource || optionsSource.length === 0) {
            this.client.respondError(id, "OpenRemote only supports single-choice Codex questions with explicit options.");
            this.emit("error", entry.id, "Codex requested interactive input that the mobile bridge does not support yet.");
            return;
        }
        const options = optionsSource.map((option, index) => ({
            index,
            label: isRecord(option) && typeof option.label === "string"
                ? option.label
                : `Option ${index + 1}`,
            shortcutKey: null,
        }));
        const requestId = String(id);
        entry.pendingApprovals.set(requestId, {
            options,
            respond: async (optionIndex) => {
                const option = optionsSource[optionIndex];
                const label = isRecord(option) && typeof option.label === "string"
                    ? option.label
                    : options[optionIndex]?.label ?? `Option ${optionIndex + 1}`;
                this.client.respond(id, {
                    answers: {
                        [questionId]: {
                            answers: [label],
                        },
                    },
                });
            },
        });
        this.setStatus(entry, "running");
        this.emit("approval", entry.id, requestId, typeof question.header === "string" ? question.header : "Question", typeof question.question === "string"
            ? question.question
            : "Codex requires your input to continue.", options);
    }
    handleTurnFailure(entry, message) {
        if (!this.sessions.has(entry.id)) {
            return;
        }
        this.clearTransientStates(entry);
        entry.pendingDiff = null;
        entry.activeTurnId = null;
        entry.pendingApprovals.clear();
        this.writeTrace(entry, "turn-failed", { message });
        this.emit("error", entry.id, message);
        this.setStatus(entry, "failed");
    }
    handleClientClosed(reason) {
        for (const entry of [...this.sessions.values()]) {
            this.finalizeWithError(entry, `Codex app-server disconnected: ${reason}`);
        }
    }
    finalizeWithError(entry, message) {
        if (!this.sessions.has(entry.id)) {
            return;
        }
        this.writeTrace(entry, "session-failed", { message });
        this.emit("error", entry.id, message);
        this.finalizeSession(entry, "failed", 1, false);
    }
    finalizeSession(entry, status, exitCode, emitStatus = true) {
        if (!this.sessions.has(entry.id)) {
            return;
        }
        if (emitStatus) {
            this.setStatus(entry, status);
        }
        else {
            entry.status = status;
        }
        if (entry.timeout) {
            clearTimeout(entry.timeout);
            entry.timeout = null;
        }
        if (entry.providerSessionId) {
            this.sessionByThreadId.delete(entry.providerSessionId);
        }
        this.clearTransientStates(entry);
        entry.activeTurnId = null;
        entry.pendingApprovals.clear();
        this.writeTrace(entry, "session-finalized", { status, exitCode });
        this.emit("complete", entry.id, exitCode, Date.now() - entry.startedAt);
        this.closeTrace(entry);
        this.sessions.delete(entry.id);
        if (this.sessions.size === 0) {
            void this.client.stop();
        }
    }
    setStatus(entry, status) {
        if (!this.sessions.has(entry.id) || entry.status === status) {
            return;
        }
        entry.status = status;
        this.emit("status", entry.id, status);
    }
    emitReadableBlock(entry, block) {
        this.emit("readableBlock", entry.id, {
            ...block,
            occurredAt: block.occurredAt ?? new Date().toISOString(),
        });
    }
    setReasoningActive(entry, active) {
        if (entry.reasoningActive === active) {
            return;
        }
        entry.reasoningActive = active;
        this.emitReadableBlock(entry, {
            kind: "thinking",
            title: "Thinking",
            body: "Thinking",
            metadata: {
                active,
            },
        });
    }
    setCommandRunning(entry, running) {
        const nextCount = running
            ? entry.commandRunning + 1
            : Math.max(0, entry.commandRunning - 1);
        const wasActive = entry.commandRunning > 0;
        const isActive = nextCount > 0;
        entry.commandRunning = nextCount;
        if (wasActive === isActive) {
            return;
        }
        this.emitReadableBlock(entry, {
            kind: "command",
            title: "Running commands",
            body: "Running commands",
            metadata: {
                active: isActive,
                state: isActive ? "running" : "completed",
                displayMode: "status-only",
            },
        });
    }
    emitFinalDiffIfNeeded(entry) {
        const diff = entry.pendingDiff?.trim();
        entry.pendingDiff = null;
        if (!diff || diff === entry.lastEmittedDiff) {
            return;
        }
        entry.lastEmittedDiff = diff;
        this.emitReadableBlock(entry, {
            kind: "code",
            title: "Code",
            body: diff,
            metadata: {
                format: "diff",
                languageHint: "diff",
                final: true,
            },
        });
    }
    clearTransientStates(entry) {
        this.setReasoningActive(entry, false);
        while (entry.commandRunning > 0) {
            this.setCommandRunning(entry, false);
        }
    }
    getSessionByThreadId(threadId) {
        const sessionId = this.sessionByThreadId.get(threadId);
        if (!sessionId) {
            return null;
        }
        return this.sessions.get(sessionId) ?? null;
    }
    labelCommandDecision(decision) {
        if (decision === "accept")
            return "Approve";
        if (decision === "acceptForSession")
            return "Approve for session";
        if (decision === "decline")
            return "Deny";
        if (decision === "cancel")
            return "Cancel";
        if (isRecord(decision) && "acceptWithExecpolicyAmendment" in decision) {
            return "Approve and remember";
        }
        if (isRecord(decision) && "applyNetworkPolicyAmendment" in decision) {
            return "Approve network rule";
        }
        return "Approve";
    }
    labelFileDecision(decision) {
        switch (decision) {
            case "accept":
                return "Approve";
            case "acceptForSession":
                return "Approve for session";
            case "decline":
                return "Deny";
            case "cancel":
                return "Cancel";
            default:
                return "Approve";
        }
    }
    ensureTrace(entry) {
        if (entry.ptyTraceStream && entry.ptyTracePath) {
            return;
        }
        const logsDir = path.join(homedir(), ".openremote", "pty-logs");
        mkdirSync(logsDir, { recursive: true });
        const tracePath = path.join(logsDir, `${entry.id}-${Date.now()}.jsonl`);
        entry.ptyTracePath = tracePath;
        entry.ptyTraceStream = createWriteStream(tracePath, { flags: "a" });
        this.writeTrace(entry, "trace-start", {
            sessionId: entry.id,
            projectPath: entry.projectPath,
            tracePath,
            transport: "codex-app-server",
        });
        this.emit("sessionLog", entry.id, tracePath);
        log.debug(`${ts()} session ${entry.id} - app-server trace ${tracePath}`);
    }
    writeTrace(entry, event, payload) {
        if (!entry.ptyTraceStream) {
            return;
        }
        entry.ptyTraceStream.write(`${JSON.stringify({
            ts: new Date().toISOString(),
            event,
            ...payload,
        })}\n`);
    }
    closeTrace(entry) {
        if (!entry.ptyTraceStream) {
            return;
        }
        this.writeTrace(entry, "trace-end", { sessionId: entry.id, status: entry.status });
        entry.ptyTraceStream.end();
        entry.ptyTraceStream = null;
    }
}
//# sourceMappingURL=codex-runner.js.map