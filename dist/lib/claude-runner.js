import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { buildShellCommand, getShellLaunch } from "./shell.js";
import { log } from "./logger.js";
function ts() {
    return `[${new Date().toISOString()}] [claude-runner]`;
}
function mapClaudeModel(name) {
    switch (name) {
        case "claude-sonnet-4-6":
        case "claude-sonnet-4":
            return "claude-sonnet-4-6";
        case "claude-opus-4-8":
            return "claude-opus-4-8";
        case "claude-opus-4-7":
        case "claude-opus-4-6":
        case "claude-opus-4":
            return "claude-opus-4-7";
        case "claude-haiku-4-5":
        case "claude-haiku-3.5":
            return "claude-haiku-4-5-20251001";
        default:
            return name;
    }
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function mapClaudePermissionMode(mode, permissionsGranted) {
    if (permissionsGranted || mode === "full-auto") {
        return "bypassPermissions";
    }
    if (mode === "auto-edit") {
        return "acceptEdits";
    }
    return "default";
}
/** Returns true if the result text looks like a Claude permission denial. */
function isPermissionError(text) {
    const lower = text.toLowerCase();
    return (lower.includes("requested permissions") ||
        lower.includes("haven't granted it yet") ||
        lower.includes("permission denied") ||
        lower.includes("not granted permission") ||
        lower.includes("requires approval") ||
        lower.includes("require approval") ||
        lower.includes("permission required") ||
        lower.includes("user rejected"));
}
/** Cached result so we only run `where claude` once per process lifetime. */
let _windowsClaudeResolution = undefined;
/**
 * On Windows, npm installs CLIs as `.cmd` wrappers around a Node.js script.
 * Spawning via `cmd.exe /c claude args…` re-joins and re-parses every argument
 * through cmd.exe's quoting rules, which mangles special characters (French
 * accents, quotes, etc.).  Instead we locate the real `.js` entry point from
 * the `.cmd` file and spawn `node script.js args…` directly — Node.js passes
 * each array element as a separate OS argument with no intermediate shell.
 *
 * Returns `{ executable, prefixArgs }` where the final command is:
 *   spawn(executable, [...prefixArgs, ...claudeArgs])
 *
 * Falls back to `null` if resolution fails (caller then uses cmd.exe).
 */
function resolveWindowsClaudeCommand() {
    if (_windowsClaudeResolution !== undefined)
        return _windowsClaudeResolution;
    // Parse a .cmd wrapper to find either a .js script (npm-style) or a .exe (native binary).
    // Returns { kind: "node", path } for .js or { kind: "exe", path } for .exe.
    const tryResolveFromCmd = (cmdPath) => {
        try {
            if (!existsSync(cmdPath))
                return null;
            const cmdContent = readFileSync(cmdPath, "utf-8");
            const dp0 = path.dirname(cmdPath);
            const resolveTokens = (p) => path.resolve(p.replace(/%~dp0%?/gi, dp0 + "\\").replace(/%dp0%/gi, dp0 + "\\"));
            // Prefer .exe (native binary) — Claude Code ships an embedded Node runtime
            const exeMatches = [...cmdContent.matchAll(/"([^"]+\.exe)"/gi)];
            for (const m of exeMatches) {
                const exePath = resolveTokens(m[1]);
                if (existsSync(exePath))
                    return { kind: "exe", path: exePath };
            }
            // Otherwise look for a .js script (older npm-wrapper style)
            const jsMatches = [...cmdContent.matchAll(/"([^"]+\.js)"/gi)];
            for (const m of jsMatches) {
                const scriptPath = resolveTokens(m[1]);
                if (existsSync(scriptPath) && /cli\.js$/i.test(scriptPath)) {
                    return { kind: "node", path: scriptPath };
                }
            }
            return null;
        }
        catch {
            return null;
        }
    };
    const candidateScriptPaths = [];
    const candidateCmdPaths = [];
    try {
        // 1) `where claude` — collect ALL hits (.cmd, .ps1, .exe)
        const where = spawnSync("where", ["claude"], { encoding: "utf-8", timeout: 5_000 });
        if (where.status === 0 && where.stdout) {
            const paths = where.stdout.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            for (const p of paths) {
                if (p.toLowerCase().endsWith(".cmd"))
                    candidateCmdPaths.push(p);
            }
        }
    }
    catch (err) {
        log.debug(`[claude-runner] 'where claude' failed: ${err}`);
    }
    // 2) Common npm global locations
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const userProfile = process.env.USERPROFILE;
    const candidates = [
        appData && path.join(appData, "npm", "claude.cmd"),
        appData && path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
        userProfile && path.join(userProfile, "AppData", "Roaming", "npm", "claude.cmd"),
        userProfile && path.join(userProfile, "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
        localAppData && path.join(localAppData, "npm", "claude.cmd"),
    ].filter((p) => Boolean(p));
    for (const c of candidates) {
        if (c.toLowerCase().endsWith(".cmd"))
            candidateCmdPaths.push(c);
        else if (c.toLowerCase().endsWith(".js"))
            candidateScriptPaths.push(c);
    }
    // 3) `npm root -g` as last resort
    try {
        const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf-8", timeout: 5_000, shell: true });
        if (npmRoot.status === 0 && npmRoot.stdout) {
            const root = npmRoot.stdout.trim();
            if (root) {
                candidateScriptPaths.push(path.join(root, "@anthropic-ai", "claude-code", "cli.js"));
            }
        }
    }
    catch (err) {
        log.debug(`[claude-runner] 'npm root -g' failed: ${err}`);
    }
    // Try parsing .cmd wrappers first — they may point to .exe (native binary, preferred)
    // or .js (legacy npm wrapper). .exe is the modern Claude Code distribution.
    for (const cmdPath of candidateCmdPaths) {
        const resolved = tryResolveFromCmd(cmdPath);
        if (!resolved)
            continue;
        if (resolved.kind === "exe") {
            log.debug(`[claude-runner] Resolved claude via .cmd → .exe: ${resolved.path}`);
            _windowsClaudeResolution = { executable: resolved.path, prefixArgs: [] };
            return _windowsClaudeResolution;
        }
        log.debug(`[claude-runner] Resolved claude via .cmd → node script: ${resolved.path}`);
        _windowsClaudeResolution = { executable: process.execPath, prefixArgs: [resolved.path] };
        return _windowsClaudeResolution;
    }
    // Fall back to direct .js script paths
    for (const scriptPath of candidateScriptPaths) {
        if (existsSync(scriptPath)) {
            log.debug(`[claude-runner] Resolved claude via direct script: ${scriptPath}`);
            _windowsClaudeResolution = { executable: process.execPath, prefixArgs: [scriptPath] };
            return _windowsClaudeResolution;
        }
    }
    log.debug(`[claude-runner] Windows claude resolution failed — falling back to cmd.exe (multiline/UTF-8 prompts may break)`);
    _windowsClaudeResolution = null;
    return null;
}
export class ClaudeRunner extends EventEmitter {
    provider = "claude";
    sessions = new Map();
    /* ------------------------------------------------------------------ */
    /*  Public API                                                         */
    /* ------------------------------------------------------------------ */
    startSession(options) {
        const entry = this.createEntry(options);
        this.sessions.set(options.sessionId, entry);
        if (entry.ptyTracePath) {
            this.emit("sessionLog", entry.id, entry.ptyTracePath);
        }
        this.spawnClaude(entry, false);
    }
    resumeSession(options) {
        const entry = this.createEntry(options);
        if (options.providerSessionId) {
            entry.providerSessionId = options.providerSessionId;
        }
        this.sessions.set(options.sessionId, entry);
        if (entry.ptyTracePath) {
            this.emit("sessionLog", entry.id, entry.ptyTracePath);
        }
        this.spawnClaude(entry, true);
    }
    /**
     * Called when the user responds to a permission approval popup.
     * optionIndex 0 = Allow, 1 = Deny
     */
    respondToSession(sessionId, requestId, optionIndex) {
        const entry = this.sessions.get(sessionId);
        if (!entry) {
            return { ok: false, error: "Session not found." };
        }
        // Handle AskUserQuestion response
        if (entry.askUserQuestionPending && entry.askUserQuestionRequestId === requestId) {
            entry.askUserQuestionPending = false;
            entry.askUserQuestionRequestId = null;
            const selected = entry.askUserQuestionOptions[optionIndex];
            const answerText = selected?.label ?? String(optionIndex);
            log.debug(`${ts()} AskUserQuestion answered for session ${sessionId}: "${answerText}"`);
            entry.prompt = answerText;
            entry.buffer = "";
            this.spawnClaude(entry, true);
            return { ok: true };
        }
        // Handle ExitPlanMode response
        if (entry.exitPlanModePending && entry.exitPlanModeRequestId === requestId) {
            entry.exitPlanModePending = false;
            entry.exitPlanModeRequestId = null;
            const plan = entry.exitPlanModePlan;
            entry.exitPlanModePlan = "";
            if (optionIndex === 0) {
                // Approve → disable plan mode and ask Claude to implement the plan.
                log.debug(`${ts()} ExitPlanMode approved for session ${sessionId}`);
                entry.planMode = false;
                entry.prompt = plan
                    ? `Proceed with implementing the plan you just presented:\n\n${plan}`
                    : "Proceed with implementing the plan you just presented.";
                entry.buffer = "";
                this.spawnClaude(entry, true);
            }
            else {
                // Keep planning → stop the session so the user can send a new prompt.
                log.debug(`${ts()} ExitPlanMode declined for session ${sessionId}`);
                this.finalizeSession(entry, "idle", 0);
            }
            return { ok: true };
        }
        if (!entry.permissionPending || entry.permissionRequestId !== requestId) {
            return { ok: false, error: "No pending permission request for this session." };
        }
        entry.permissionPending = false;
        entry.permissionRequestId = null;
        if (optionIndex === 0) {
            // User approved → re-spawn with full permissions + resume
            log.debug(`${ts()} Permission granted for session ${sessionId}, re-spawning`);
            entry.permissionsGranted = true;
            entry.buffer = "";
            this.spawnClaude(entry, true);
        }
        else {
            // User denied → cancel
            log.debug(`${ts()} Permission denied for session ${sessionId}`);
            this.finalizeSession(entry, "cancelled", 130);
        }
        return { ok: true };
    }
    inputToSession(sessionId, text, modelName, planMode, reasoningEffort, approvalMode, attachments) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return false;
        // Kill existing process if still running
        if (entry.process && entry.process.exitCode === null) {
            entry.process.kill("SIGTERM");
        }
        // Update session settings
        if (modelName)
            entry.modelName = modelName;
        if (typeof planMode === "boolean")
            entry.planMode = planMode;
        if (reasoningEffort)
            entry.reasoningEffort = reasoningEffort;
        if (approvalMode)
            entry.approvalMode = approvalMode;
        entry.prompt = text;
        entry.attachments = attachments ?? [];
        entry.buffer = "";
        entry.permissionPending = false;
        entry.permissionRequestId = null;
        // Re-spawn with --resume
        this.spawnClaude(entry, true);
        return true;
    }
    cancelSession(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return false;
        log.debug(`${ts()} Cancelling Claude session ${sessionId}`);
        this.killProcess(entry);
        this.finalizeSession(entry, "cancelled", 130);
        return true;
    }
    finishSession(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return false;
        log.debug(`${ts()} Finishing Claude session ${sessionId}`);
        this.killProcess(entry);
        this.finalizeSession(entry, "completed", 0);
        return true;
    }
    killAll() {
        for (const entry of Array.from(this.sessions.values())) {
            if (entry.status === "running" || entry.status === "queued") {
                // Active session — cancel it so the DB is updated correctly.
                this.killProcess(entry);
                this.finalizeSession(entry, "cancelled", 130);
            }
            else {
                // Idle session — process already exited, drop it without touching DB status.
                this.sessions.delete(entry.id);
            }
        }
    }
    /* ------------------------------------------------------------------ */
    /*  Private: spawn & lifecycle                                         */
    /* ------------------------------------------------------------------ */
    createEntry(options) {
        const logDir = path.join(homedir(), ".openremote", "pty-logs");
        mkdirSync(logDir, { recursive: true });
        const tracePath = path.join(logDir, `${options.sessionId}-${Date.now()}-claude.jsonl`);
        const startedAt = Date.now();
        appendFileSync(tracePath, JSON.stringify({
            t: startedAt,
            event: "trace-start",
            data: {
                sessionId: options.sessionId,
                cwd: options.projectPath,
                modelName: options.modelName,
                approvalMode: options.approvalMode,
                planMode: options.planMode,
            },
        }) + "\n", "utf8");
        const traceStream = createWriteStream(tracePath, { flags: "a" });
        return {
            id: options.sessionId,
            prompt: options.prompt,
            modelName: options.modelName,
            reasoningEffort: options.reasoningEffort,
            projectPath: options.projectPath,
            approvalMode: options.approvalMode,
            planMode: options.planMode,
            status: "queued",
            providerSessionId: options.providerSessionId ?? null,
            process: null,
            buffer: "",
            startedAt,
            ptyTracePath: tracePath,
            ptyTraceStream: traceStream,
            permissionsGranted: false,
            permissionPending: false,
            permissionRequestId: null,
            toolCallMap: new Map(),
            askUserQuestionPending: false,
            askUserQuestionRequestId: null,
            askUserQuestionOptions: [],
            exitPlanModePending: false,
            exitPlanModeRequestId: null,
            exitPlanModePlan: "",
            attachments: options.attachments ?? [],
        };
    }
    spawnClaude(entry, resume) {
        const permissionMode = entry.planMode
            ? "plan"
            : mapClaudePermissionMode(entry.approvalMode, entry.permissionsGranted);
        // Prepend image attachment instructions to the prompt
        let effectivePrompt = entry.prompt;
        if (entry.attachments.length > 0) {
            const imageLines = entry.attachments.map((filePath) => `[Image jointe: ${filePath}]\nLis cette image avec ton outil Read avant de répondre.`);
            effectivePrompt = `${imageLines.join("\n")}\n\n${entry.prompt}`;
        }
        const args = [
            "-p",
            effectivePrompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            mapClaudeModel(entry.modelName),
            "--permission-mode",
            permissionMode,
        ];
        // Resume an existing conversation
        if (resume && entry.providerSessionId) {
            args.push("--resume", entry.providerSessionId);
        }
        // YOLO mode or user already approved permission popup → skip all permissions
        // (not applicable in plan mode)
        if (!entry.planMode && (entry.approvalMode === "full-auto" || entry.permissionsGranted)) {
            args.push("--dangerously-skip-permissions");
        }
        let executable;
        let execArgs;
        if (process.platform === "win32") {
            // Bypass cmd.exe to avoid argument corruption with special characters.
            // Resolve the real Node.js script behind claude.cmd and spawn node directly.
            const resolved = resolveWindowsClaudeCommand();
            if (resolved) {
                executable = resolved.executable;
                execArgs = [...resolved.prefixArgs, ...args];
            }
            else {
                // Fallback: cmd.exe (may still corrupt args with special chars)
                executable = "cmd.exe";
                execArgs = ["/c", "claude", ...args];
            }
        }
        else {
            const shellLaunch = getShellLaunch();
            executable = shellLaunch.shell;
            execArgs = shellLaunch.argsForCommand(`exec ${buildShellCommand("claude", args)}`);
        }
        log.debug(`${ts()} Spawning: ${executable} ${execArgs.slice(0, 6).join(" ")} …`);
        this.traceEvent(entry, "launch", { executable, execArgs, cwd: entry.projectPath, resume });
        try {
            const child = spawn(executable, execArgs, {
                cwd: entry.projectPath,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
            entry.process = child;
            this.setStatus(entry, "running");
            // Stream stdout line by line
            child.stdout?.on("data", (chunk) => {
                // Drop late stdout from a superseded process (see close handler above).
                if (entry.process !== child)
                    return;
                const text = chunk.toString("utf-8");
                entry.buffer += text;
                // Emit raw output for transcript
                this.emit("output", entry.id, text);
                // Process complete JSON lines
                let newlineIndex;
                while ((newlineIndex = entry.buffer.indexOf("\n")) !== -1) {
                    const line = entry.buffer.slice(0, newlineIndex).trim();
                    entry.buffer = entry.buffer.slice(newlineIndex + 1);
                    if (line.length > 0) {
                        this.handleJsonLine(entry, line);
                    }
                }
            });
            // Capture stderr
            child.stderr?.on("data", (chunk) => {
                if (entry.process !== child)
                    return;
                const text = chunk.toString("utf-8").trim();
                if (text) {
                    log.debug(`${ts()} Claude stderr: ${text}`);
                    this.traceEvent(entry, "stderr", { text });
                }
            });
            // Process exit
            child.on("close", (code) => {
                // If this entry has been re-spawned (follow-up prompt, approval
                // re-spawn, etc.), entry.process now points to a newer child. The old
                // close handler MUST NOT touch entry.buffer or entry.status — doing so
                // would wipe the new process's in-flight stdout and mark the entry as
                // failed even though the new run is healthy.
                if (entry.process !== child) {
                    log.debug(`${ts()} Ignoring close of superseded Claude process (code=${code})`);
                    this.traceEvent(entry, "process-exit-superseded", { code });
                    return;
                }
                const exitCode = code ?? 1;
                log.debug(`${ts()} Claude process exited with code ${exitCode}`);
                this.traceEvent(entry, "process-exit", { code: exitCode });
                // Process any remaining buffer
                if (entry.buffer.trim().length > 0) {
                    this.handleJsonLine(entry, entry.buffer.trim());
                    entry.buffer = "";
                }
                // If waiting for a mobile response, don't finalize the session.
                // Claude is intentionally stopped for these tool-driven prompts and
                // will be resumed after the user responds.
                if (entry.permissionPending ||
                    entry.askUserQuestionPending ||
                    entry.exitPlanModePending) {
                    return;
                }
                // Only finalize if session is still active
                if (entry.status === "running" ||
                    entry.status === "queued") {
                    if (code === 0) {
                        if (!entry.providerSessionId) {
                            const detail = "Claude exited before emitting its stream-json init event. The process ended before OpenRemote could attach to a Claude session.";
                            this.traceEvent(entry, "missing-init", { detail });
                            this.emit("error", entry.id, detail);
                            this.finalizeSession(entry, "failed", 1);
                        }
                        else {
                            this.setStatus(entry, "idle");
                        }
                    }
                    else {
                        this.emit("error", entry.id, `Claude process exited with code ${exitCode}`);
                        this.finalizeSession(entry, "failed", exitCode);
                    }
                }
            });
            child.on("error", (err) => {
                if (entry.process !== child) {
                    log.debug(`${ts()} Ignoring error of superseded Claude process: ${err.message}`);
                    return;
                }
                log.debug(`${ts()} Claude spawn error: ${err.message}`);
                this.traceEvent(entry, "spawn-error", { error: err.message });
                this.emit("error", entry.id, `Failed to spawn Claude: ${err.message}`);
                this.finalizeSession(entry, "failed", 1);
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.debug(`${ts()} Claude spawn exception: ${msg}`);
            this.traceEvent(entry, "spawn-exception", { error: msg });
            this.emit("error", entry.id, `Failed to start Claude: ${msg}`);
            this.finalizeSession(entry, "failed", 1);
        }
    }
    /* ------------------------------------------------------------------ */
    /*  Private: JSON line processing                                      */
    /* ------------------------------------------------------------------ */
    handleJsonLine(entry, line) {
        let data;
        try {
            data = JSON.parse(line);
        }
        catch {
            log.debug(`${ts()} Unparseable JSON line: ${line.slice(0, 200)}`);
            return;
        }
        this.traceEvent(entry, "stream-event", data);
        const eventType = data.type;
        // Events with parent_tool_use_id come from inside a sub-agent (Agent tool).
        // These are the sub-agent's internal tool calls (Read, Glob, etc.) and we
        // suppress them to avoid flooding the UI — VS Code does the same thing.
        const parentToolUseId = data.parent_tool_use_id;
        switch (eventType) {
            case "system":
                this.handleSystemEvent(entry, data);
                break;
            case "assistant":
                if (!parentToolUseId) {
                    this.handleAssistantEvent(entry, data);
                }
                else {
                    // Sub-agent (Agent tool): suppress internal text/thinking/commands to
                    // avoid noise, but surface Edit and Write tool calls so the user can
                    // see which files were modified.
                    this.handleSubAgentAssistantEvent(entry, data);
                }
                break;
            case "user":
                if (!parentToolUseId)
                    this.handleUserEvent(entry, data);
                break;
            case "result":
                if (!parentToolUseId)
                    this.handleResultEvent(entry, data);
                break;
            default:
                break;
        }
    }
    handleSystemEvent(entry, data) {
        if (data.subtype === "init") {
            const sessionId = data.session_id;
            if (sessionId) {
                entry.providerSessionId = sessionId;
                this.emit("providerSession", entry.id, sessionId);
                log.debug(`${ts()} Claude session ID: ${sessionId}`);
            }
            if (entry.ptyTracePath) {
                this.emit("sessionLog", entry.id, entry.ptyTracePath);
            }
        }
    }
    handleAssistantEvent(entry, data) {
        const message = data.message;
        if (!message)
            return;
        const content = message.content;
        if (!Array.isArray(content))
            return;
        for (const block of content) {
            if (!isRecord(block))
                continue;
            const blockType = block.type;
            switch (blockType) {
                case "thinking": {
                    const thinking = block.thinking;
                    if (thinking) {
                        this.emitBlock(entry, "thinking", null, thinking);
                    }
                    break;
                }
                case "text": {
                    const text = block.text;
                    if (text) {
                        this.emitBlock(entry, "text", null, text);
                    }
                    break;
                }
                case "tool_use": {
                    this.handleToolUseBlock(entry, block);
                    break;
                }
            }
        }
    }
    /**
     * For sub-agent events (parent_tool_use_id set): only surface Edit and Write
     * tool calls so the user can see which files were actually modified. All
     * other blocks (text, thinking, Bash, Read, Glob, …) are suppressed.
     */
    handleSubAgentAssistantEvent(entry, data) {
        const message = data.message;
        if (!message)
            return;
        const content = message.content;
        if (!Array.isArray(content))
            return;
        for (const block of content) {
            if (!isRecord(block))
                continue;
            if (block.type !== "tool_use")
                continue;
            const toolName = block.name;
            if (toolName === "Edit" || toolName === "Write") {
                this.handleToolUseBlock(entry, block);
            }
        }
    }
    handleToolUseBlock(entry, block) {
        const toolName = block.name;
        const input = block.input;
        switch (toolName) {
            case "Bash": {
                const command = input?.command ?? "";
                const description = input?.description ?? "";
                entry.toolCallMap.set(block.id, "Bash");
                this.emitBlock(entry, "command", toolName, command, {
                    tool: "Bash",
                    ...(description ? { description } : {}),
                });
                break;
            }
            case "Edit": {
                const filePath = input?.file_path ?? "";
                const oldStr = input?.old_string ?? "";
                const newStr = input?.new_string ?? "";
                const prefixLines = (text, prefix) => text.length === 0
                    ? ""
                    : text.split("\n").map((line) => prefix + line).join("\n");
                const oldBlock = prefixLines(oldStr, "-");
                const newBlock = prefixLines(newStr, "+");
                const body = [
                    `--- ${filePath}`,
                    `+++ ${filePath}`,
                    ...(oldBlock ? [oldBlock] : []),
                    ...(newBlock ? [newBlock] : []),
                ].join("\n");
                const oldLines = oldStr ? oldStr.split("\n").length : 0;
                const newLines = newStr ? newStr.split("\n").length : 0;
                const changeDescription = oldStr === "" && newStr !== ""
                    ? `Added ${newLines} line${newLines > 1 ? "s" : ""}`
                    : newStr === "" && oldStr !== ""
                        ? `Removed ${oldLines} line${oldLines > 1 ? "s" : ""}`
                        : "Modified";
                entry.toolCallMap.set(block.id, "Edit");
                this.emitBlock(entry, "code", filePath, body, {
                    tool: "Edit",
                    format: "diff",
                    languageHint: "diff",
                    filePath,
                    changeDescription,
                });
                break;
            }
            case "Write": {
                const filePath = input?.file_path ?? "";
                const content = input?.content ?? "";
                const lineCount = content ? content.split("\n").length : 0;
                const preview = content.length > 500
                    ? content.slice(0, 500) + "\n... (truncated)"
                    : content;
                entry.toolCallMap.set(block.id, "Write");
                this.emitBlock(entry, "code", filePath, preview, {
                    tool: "Write",
                    filePath,
                    lineCount,
                    totalLength: content.length,
                });
                break;
            }
            case "Read": {
                const filePath = input?.file_path ?? "";
                entry.toolCallMap.set(block.id, "Read");
                this.emitBlock(entry, "path", toolName, filePath, { tool: "Read" });
                break;
            }
            case "Glob":
            case "Grep": {
                const pattern = input?.pattern ?? "";
                entry.toolCallMap.set(block.id, toolName);
                this.emitBlock(entry, "command", toolName, pattern, { tool: toolName });
                break;
            }
            case "TodoWrite": {
                const todos = input?.todos ?? [];
                const todoLines = todos
                    .map((t) => {
                    const status = t.status ?? "pending";
                    const content = t.content ?? "";
                    const icon = status === "completed" ? "\u2713" : status === "in_progress" ? "\u2731" : "\u2610";
                    return `${icon} ${content}`;
                })
                    .join("\n");
                entry.toolCallMap.set(block.id, "TodoWrite");
                this.emitBlock(entry, "text", "Update Todos", todoLines, {
                    tool: "TodoWrite",
                    todos: todos.map((t) => ({ status: t.status, content: t.content })),
                });
                break;
            }
            case "Agent": {
                const agentPrompt = input?.prompt ?? input?.task ?? "";
                const desc = input?.description ?? "";
                const preview = agentPrompt.length > 300
                    ? agentPrompt.slice(0, 300) + "..."
                    : agentPrompt;
                entry.toolCallMap.set(block.id, "Agent");
                this.emitBlock(entry, "text", desc || "Agent", preview, {
                    tool: "Agent",
                    description: desc,
                });
                break;
            }
            case "Skill": {
                const skillName = input?.skill ?? "";
                entry.toolCallMap.set(block.id, "Skill");
                this.emitBlock(entry, "command", `Skill: ${skillName}`, skillName, {
                    tool: "Skill",
                });
                break;
            }
            case "ExitPlanMode": {
                const plan = input?.plan ?? "";
                const requestId = `exit-plan-${Date.now()}`;
                entry.exitPlanModePending = true;
                entry.exitPlanModeRequestId = requestId;
                entry.exitPlanModePlan = plan;
                entry.toolCallMap.set(block.id, "ExitPlanMode");
                // Stop the process so Claude doesn't keep running after the tool
                // triggers its internal "can't exit plan mode" error.
                this.killProcess(entry);
                const options = [
                    { index: 0, label: "Approve and implement", shortcutKey: "y" },
                    { index: 1, label: "Keep planning", shortcutKey: "n" },
                ];
                log.debug(`${ts()} ExitPlanMode raised for session ${entry.id}`);
                this.traceEvent(entry, "exit-plan-mode", { requestId, plan });
                this.emit("approval", entry.id, requestId, "Exit plan mode?", plan, options);
                break;
            }
            case "AskUserQuestion": {
                const questions = Array.isArray(input?.questions) ? input.questions : [];
                if (questions.length === 0)
                    break;
                const q = isRecord(questions[0]) ? questions[0] : {};
                const questionText = q.question ?? "";
                const header = q.header || "Claude asks";
                const rawOptions = Array.isArray(q.options) ? q.options : [];
                const questionOptions = rawOptions
                    .filter(isRecord)
                    .map((opt) => ({
                    label: opt.label ?? "",
                    description: typeof opt.description === "string" ? opt.description : undefined,
                }))
                    .filter((opt) => opt.label.length > 0);
                const requestId = `ask-${Date.now()}`;
                entry.askUserQuestionPending = true;
                entry.askUserQuestionRequestId = requestId;
                entry.askUserQuestionOptions = questionOptions;
                entry.toolCallMap.set(block.id, "AskUserQuestion");
                // Kill the process so Claude doesn't continue after the tool fails
                this.killProcess(entry);
                const parsedOptions = questionOptions.map((opt, i) => ({
                    index: i,
                    label: opt.label,
                    shortcutKey: String(i + 1),
                    description: opt.description,
                }));
                log.debug(`${ts()} AskUserQuestion raised for session ${entry.id}: ${header}`);
                this.traceEvent(entry, "ask-user-question", { requestId, header, questionText, options: parsedOptions });
                this.emit("approval", entry.id, requestId, header, questionText, parsedOptions, "ask");
                break;
            }
            default: {
                const inputStr = input ? JSON.stringify(input).slice(0, 300) : "";
                entry.toolCallMap.set(block.id, toolName);
                this.emitBlock(entry, "text", toolName, `Tool: ${toolName}\n${inputStr}`, {
                    tool: toolName,
                });
                break;
            }
        }
    }
    handleUserEvent(entry, data) {
        const message = data.message;
        if (!message)
            return;
        const content = message.content;
        if (!Array.isArray(content))
            return;
        for (const block of content) {
            if (!isRecord(block))
                continue;
            if (block.type === "tool_result") {
                const resultContent = block.content;
                const isError = block.is_error === true;
                const toolUseId = block.tool_use_id;
                const toolName = toolUseId ? entry.toolCallMap.get(toolUseId) : undefined;
                if (toolUseId)
                    entry.toolCallMap.delete(toolUseId);
                if (resultContent && resultContent.length > 0) {
                    // Check if this is a permission error → trigger approval popup
                    if (isError &&
                        isPermissionError(resultContent) &&
                        entry.approvalMode !== "full-auto" &&
                        !entry.permissionsGranted &&
                        !entry.permissionPending) {
                        this.raisePermissionApproval(entry, resultContent);
                        continue;
                    }
                    // Suppress any permission-denied tool_result once approval is already
                    // pending or granted — prevents the "Permission denied" text from
                    // appearing in the chat after the user taps Accept.
                    if (isError && isPermissionError(resultContent)) {
                        continue;
                    }
                    // Suppress internal tool results that are noise to the user.
                    // Read: file content (Claude's internal reading, not useful to display)
                    // Write/Edit: confirmation messages ("File written successfully")
                    // TodoWrite/Agent/Skill: internal operation results
                    const suppressedTools = new Set(["Read", "Write", "Edit", "TodoWrite", "Agent", "Skill"]);
                    if (toolName && suppressedTools.has(toolName)) {
                        continue;
                    }
                    const truncated = resultContent.length > 2000
                        ? resultContent.slice(0, 2000) + "\n... (truncated)"
                        : resultContent;
                    const meta = {};
                    if (toolName) {
                        meta.sourceTool = toolName;
                    }
                    if (toolName === "Glob" || toolName === "Grep") {
                        // Only store the count — the full file list is noise
                        const lines = resultContent.trim().split("\n").filter(Boolean);
                        meta.resultCount = lines.length;
                    }
                    this.emitBlock(entry, isError ? "error" : "output", null, truncated, Object.keys(meta).length > 0 ? meta : undefined);
                }
            }
        }
    }
    handleResultEvent(entry, data) {
        const isError = data.is_error === true;
        const subtype = data.subtype;
        const resultText = data.result ?? "";
        if (isError || subtype === "error") {
            // Check if this is a permission error — show approval popup instead of failing
            if (isPermissionError(resultText) &&
                entry.approvalMode !== "full-auto" &&
                !entry.permissionsGranted &&
                !entry.permissionPending) {
                this.raisePermissionApproval(entry, resultText);
                return;
            }
            // Suppress permission-denied error emissions when an approval is already
            // pending or has been granted — otherwise the user sees "Permission
            // denied" right after tapping Accept, because Claude's final result event
            // replays the same error text from the tool call.
            if (isPermissionError(resultText)) {
                return;
            }
            this.emit("error", entry.id, resultText || "Unknown error");
        }
    }
    raisePermissionApproval(entry, errorText) {
        const requestId = `perm-${Date.now()}`;
        entry.permissionPending = true;
        entry.permissionRequestId = requestId;
        // Extract the meaningful part of the error for display
        const message = errorText.length > 300 ? errorText.slice(0, 300) + "…" : errorText;
        const options = [
            { index: 0, label: "Approve", shortcutKey: "y" },
            { index: 1, label: "Deny", shortcutKey: "n" },
        ];
        log.debug(`${ts()} Raising permission approval for session ${entry.id}`);
        this.traceEvent(entry, "permission-approval", { requestId, message });
        this.setStatus(entry, "running");
        this.emit("approval", entry.id, requestId, "Permissions requises", message, options);
    }
    /* ------------------------------------------------------------------ */
    /*  Private: helpers                                                    */
    /* ------------------------------------------------------------------ */
    emitBlock(entry, kind, title, body, metadata) {
        const block = {
            kind,
            body,
            ...(title ? { title } : {}),
            ...(metadata ? { metadata } : {}),
        };
        this.traceEvent(entry, "emit-block", {
            kind,
            title,
            bodyPreview: body.slice(0, 120),
            bodyLength: body.length,
            metadata,
        });
        this.emit("readableBlock", entry.id, block);
    }
    setStatus(entry, status) {
        entry.status = status;
        this.emit("status", entry.id, status);
    }
    finalizeSession(entry, status, exitCode) {
        const duration = Date.now() - entry.startedAt;
        this.traceEvent(entry, "trace-end", { status, exitCode, duration });
        if (entry.ptyTraceStream) {
            entry.ptyTraceStream.end();
            entry.ptyTraceStream = null;
        }
        // Clean up downloaded attachment files
        if (entry.attachments.length > 0) {
            const attachmentDir = path.join(tmpdir(), "openremote-attachments", entry.id);
            try {
                if (existsSync(attachmentDir)) {
                    rmSync(attachmentDir, { recursive: true, force: true });
                    log.debug(`${ts()} Cleaned up attachments at ${attachmentDir}`);
                }
            }
            catch (err) {
                log.debug(`${ts()} Failed to clean up attachments: ${err}`);
            }
        }
        entry.status = status;
        this.emit("status", entry.id, status);
        this.emit("complete", entry.id, exitCode, duration);
        this.sessions.delete(entry.id);
    }
    killProcess(entry) {
        if (!entry.process || entry.process.exitCode !== null)
            return;
        entry.process.kill("SIGTERM");
        const killTimer = setTimeout(() => {
            if (entry.process && entry.process.exitCode === null) {
                entry.process.kill("SIGKILL");
            }
        }, 5000);
        entry.process.once("close", () => {
            clearTimeout(killTimer);
        });
    }
    traceEvent(entry, event, data) {
        if (!entry.ptyTraceStream)
            return;
        const line = JSON.stringify({ t: Date.now(), event, data });
        entry.ptyTraceStream.write(line + "\n");
    }
}
//# sourceMappingURL=claude-runner.js.map