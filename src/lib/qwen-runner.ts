import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { log } from "./logger.js";
import type { ProviderRunner, ProviderSessionOptions } from "./provider-runner.js";
import { buildShellCommand, getShellLaunch, resolveExecutable } from "./shell.js";
import type {
  ParsedOption,
  RunnerEvents,
  SessionReadableBlockIngest,
  SessionStatus,
} from "./types.js";

function ts() {
  return `[${new Date().toISOString()}] [qwen-runner]`;
}

/**
 * Minimal VT100 terminal screen emulator.
 * Handles cursor positioning, erase-to-EOL, and clear-screen so we always
 * operate on what is actually *visible* on screen rather than the raw byte stream.
 */
class ScreenBuffer {
  private rows: string[];
  private rowReasoning: boolean[];
  private curRow = 0;
  private curCol = 0;
  private currentFgMuted = false;
  private readonly width: number;
  private readonly height: number;

  constructor(width = 220, height = 50) {
    this.width = width;
    this.height = height;
    this.rows = Array.from({ length: height }, () => "");
    this.rowReasoning = Array.from({ length: height }, () => false);
  }

  isRowReasoning(row: number): boolean {
    return this.rowReasoning[row] === true;
  }

  write(raw: string): void {
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];

      if (ch === "\x1b") {
        const rest = raw.slice(i + 1);

        // OSC: ESC ] ... BEL or ST
        const oscM = rest.match(/^][^\x07]*(?:\x07|\x1b\\)/);
        if (oscM) { i += 1 + oscM[0].length; continue; }

        // CSI: ESC [ params cmd
        const csiM = rest.match(/^\[([0-9;?]*)([A-Za-z@`])/);
        if (csiM) {
          i += 1 + csiM[0].length;
          const params = csiM[1];
          const cmd = csiM[2];
          const nums = params.split(";").map((n) => (n === "" ? 0 : parseInt(n, 10)));
          const p0 = nums[0] ?? 0;
          const p1 = nums[1] ?? 0;

          if (cmd === "H" || cmd === "f") {
            this.curRow = Math.min(Math.max((p0 || 1) - 1, 0), this.height - 1);
            this.curCol = Math.min(Math.max((p1 || 1) - 1, 0), this.width - 1);
          } else if (cmd === "A") {
            this.curRow = Math.max(this.curRow - (p0 || 1), 0);
          } else if (cmd === "B") {
            this.curRow = Math.min(this.curRow + (p0 || 1), this.height - 1);
          } else if (cmd === "C") {
            this.curCol = Math.min(this.curCol + (p0 || 1), this.width - 1);
          } else if (cmd === "D") {
            this.curCol = Math.max(this.curCol - (p0 || 1), 0);
          } else if (cmd === "G") {
            this.curCol = Math.min(Math.max((p0 || 1) - 1, 0), this.width - 1);
          } else if (cmd === "K") {
            // Erase line: 0=to end, 1=to start, 2=whole line
            const row = this.rows[this.curRow] ?? "";
            if (p0 === 2) {
              this.rows[this.curRow] = "";
              this.rowReasoning[this.curRow] = false;
            } else if (p0 === 1) {
              this.rows[this.curRow] = " ".repeat(this.curCol) + row.slice(this.curCol);
              this.rowReasoning[this.curRow] = false;
            } else {
              this.rows[this.curRow] = row.slice(0, this.curCol);
            }
          } else if (cmd === "J") {
            if (p0 === 2 || p0 === 3) {
              this.rows = Array.from({ length: this.height }, () => "");
              this.rowReasoning = Array.from({ length: this.height }, () => false);
              this.curRow = 0;
              this.curCol = 0;
            } else if (p0 === 0) {
              this.rows[this.curRow] = (this.rows[this.curRow] ?? "").slice(0, this.curCol);
              for (let r = this.curRow + 1; r < this.height; r++) {
                this.rows[r] = "";
                this.rowReasoning[r] = false;
              }
            }
          } else if (cmd === "m") {
            // SGR — track foreground truecolor so we can identify Qwen's muted
            // "reasoning" color (RGB 108;112;134).
            if (params === "" || nums.some((n) => n === 0)) {
              this.currentFgMuted = false;
            }
            for (let k = 0; k < nums.length - 4; k += 1) {
              if (nums[k] === 38 && nums[k + 1] === 2) {
                const r = nums[k + 2];
                const g = nums[k + 3];
                const b = nums[k + 4];
                this.currentFgMuted = r === 108 && g === 112 && b === 134;
                break;
              }
            }
          }
          // Ignore: h, l, s, u, etc.
          continue;
        }

        // ESC c — full reset
        if (rest[0] === "c") {
          this.rows = Array.from({ length: this.height }, () => "");
          this.rowReasoning = Array.from({ length: this.height }, () => false);
          this.curRow = 0; this.curCol = 0;
          this.currentFgMuted = false;
          i += 2;
          continue;
        }

        // Other two-char ESC sequences — skip
        i += rest.length > 0 ? 2 : 1;
        continue;
      }

      if (ch === "\r") {
        this.curCol = 0;
        i += 1;
        continue;
      }

      if (ch === "\n") {
        this.curRow = Math.min(this.curRow + 1, this.height - 1);
        i += 1;
        continue;
      }

      if (ch === "\x08") { // backspace
        if (this.curCol > 0) this.curCol -= 1;
        i += 1;
        continue;
      }

      // Skip other control chars
      if (ch < " " && ch !== "\t") {
        i += 1;
        continue;
      }

      // Printable char — write to buffer
      if (this.curRow < this.height) {
        const row = this.rows[this.curRow] ?? "";
        const padded = row.padEnd(this.curCol + 1, " ");
        this.rows[this.curRow] =
          padded.slice(0, this.curCol) + ch + padded.slice(this.curCol + 1);
        // Track Qwen's internal reasoning: ✦ printed in the muted gray color.
        if (ch === "\u2726") {
          this.rowReasoning[this.curRow] = this.currentFgMuted;
        }
        this.curCol = Math.min(this.curCol + 1, this.width - 1);
      }
      i += 1;
    }
  }

  getScreen(): string {
    return this.rows.map((r) => r.trimEnd()).join("\n");
  }

  reset(): void {
    this.rows = Array.from({ length: this.height }, () => "");
    this.rowReasoning = Array.from({ length: this.height }, () => false);
    this.curRow = 0;
    this.curCol = 0;
    this.currentFgMuted = false;
  }
}

function sanitizePtyEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  return env;
}

interface SessionEntry {
  id: string;
  prompt: string;
  modelName: string;
  reasoningEffort: string;
  projectPath: string;
  approvalMode: "full-auto" | "auto-edit" | "suggest";
  status: SessionStatus;
  startedAt: number;
  exitCode: number | null;
  pty: pty.IPty | null;
  timeout: ReturnType<typeof setTimeout> | null;
  pendingOptions: ParsedOption[];
  pendingRequestId: string | null;
  idleCompletionTimer: ReturnType<typeof setTimeout> | null;
  launchId: number;
  providerSessionId: string;
  awaitingApproval: boolean;
  lastApprovalSignature: string | null;
  lastResolvedApprovalSignature: string | null;
  lastApprovalResolvedAt: number;
  requestCounter: number;
  commandActive: boolean;
  ptyTracePath: string | null;
  ptyTraceStream: WriteStream | null;
  screen: ScreenBuffer;
  emittedToolSignatures: Set<string>;
  // Map of "first-30-chars key" → { text: longest capture, timer }
  pendingTextBlocks: Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null }>;
  emittedTextBodies: Set<string>;
  // Legacy fields kept for flush compatibility
  pendingAssistantText: string;
  emittedAssistantText: string;
  assistantEmitTimer: ReturnType<typeof setTimeout> | null;
  lastThinkingLabel: string | null;
  lastActionTitle: string | null;
  lastActionMessage: string | null;
}

function buildPromptWithAttachments(prompt: string, attachments?: string[]): string {
  if (!attachments || attachments.length === 0) return prompt;
  const refs = attachments.map((p) => `@${p}`).join(" ");
  return `${refs} ${prompt}`;
}

export class QwenRunner extends EventEmitter implements ProviderRunner {
  readonly provider = "qwen" as const;
  private sessions = new Map<string, SessionEntry>();

  override on<K extends keyof RunnerEvents>(event: K, fn: RunnerEvents[K]): this {
    return super.on(event, fn);
  }

  override emit<K extends keyof RunnerEvents>(
    event: K,
    ...args: Parameters<RunnerEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  startSession(options: ProviderSessionOptions): void {
    const {
      sessionId,
      projectPath,
      modelName,
      reasoningEffort,
      approvalMode,
      providerSessionId,
      timeoutMs = 0,
      attachments,
    } = options;
    const prompt = buildPromptWithAttachments(options.prompt, attachments);

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        log.debug(`${ts()} session ${sessionId} timed out`);
        this.cancelSession(sessionId);
      }, timeoutMs);
    }

    const entry: SessionEntry = {
      id: sessionId,
      prompt,
      modelName,
      reasoningEffort,
      projectPath,
      approvalMode,
      status: "queued",
      startedAt: Date.now(),
      exitCode: null,
      pty: null,
      timeout: timer,
      pendingOptions: [],
      pendingRequestId: null,
      idleCompletionTimer: null,
      launchId: 0,
      providerSessionId: providerSessionId ?? sessionId,
      awaitingApproval: false,
      lastApprovalSignature: null,
      lastResolvedApprovalSignature: null,
      lastApprovalResolvedAt: 0,
      requestCounter: 0,
      commandActive: false,
      ptyTracePath: null,
      ptyTraceStream: null,
      screen: new ScreenBuffer(),
      emittedToolSignatures: new Set<string>(),
      pendingTextBlocks: new Map(),
      emittedTextBodies: new Set(),
      pendingAssistantText: "",
      emittedAssistantText: "",
      assistantEmitTimer: null,
      lastThinkingLabel: null,
      lastActionTitle: null,
      lastActionMessage: null,
    };

    this.ensureTrace(entry);
    this.sessions.set(sessionId, entry);
    this.launchProcess(entry, prompt, false);
  }

  resumeSession(options: ProviderSessionOptions): void {
    const {
      sessionId,
      projectPath,
      modelName,
      reasoningEffort,
      approvalMode,
      providerSessionId,
      attachments,
    } = options;
    const prompt = buildPromptWithAttachments(options.prompt, attachments);

    const entry: SessionEntry = {
      id: sessionId,
      prompt,
      modelName,
      reasoningEffort,
      projectPath,
      approvalMode,
      status: "idle",
      startedAt: Date.now(),
      exitCode: null,
      pty: null,
      timeout: null,
      pendingOptions: [],
      pendingRequestId: null,
      idleCompletionTimer: null,
      launchId: 0,
      providerSessionId: providerSessionId ?? sessionId,
      awaitingApproval: false,
      lastApprovalSignature: null,
      lastResolvedApprovalSignature: null,
      lastApprovalResolvedAt: 0,
      requestCounter: 0,
      commandActive: false,
      ptyTracePath: null,
      ptyTraceStream: null,
      screen: new ScreenBuffer(),
      emittedToolSignatures: new Set<string>(),
      pendingTextBlocks: new Map(),
      emittedTextBodies: new Set(),
      pendingAssistantText: "",
      emittedAssistantText: "",
      assistantEmitTimer: null,
      lastThinkingLabel: null,
      lastActionTitle: null,
      lastActionMessage: null,
    };

    this.ensureTrace(entry);
    this.sessions.set(sessionId, entry);
    this.launchProcess(entry, prompt, true);
  }

  respondToSession(
    sessionId: string,
    requestId: string,
    optionIndex: number,
  ): { ok: boolean; error?: string } {
    const entry = this.sessions.get(sessionId);
    log.debug(
      `${ts()} respondToSession: sessionId=${sessionId}, requestId=${requestId}, optionIndex=${optionIndex}`,
    );
    log.debug(`${ts()} respondToSession: entry=${!!entry}, pty=${!!entry?.pty}`);
    log.debug(`${ts()} respondToSession: pendingOptions=${JSON.stringify(entry?.pendingOptions)}`);

    if (!entry || !entry.pty) {
      log.debug(`${ts()} respondToSession: early return - no entry or pty`);
      return {
        ok: false,
        error: "Approval could not be resolved because the session is no longer active.",
      };
    }

    if (!entry.awaitingApproval || !entry.pendingRequestId) {
      return {
        ok: false,
        error: "Approval could not be resolved because there is no pending request.",
      };
    }

    if (entry.pendingRequestId !== requestId) {
      return {
        ok: false,
        error: "Approval could not be resolved because a newer request replaced it.",
      };
    }

    entry.awaitingApproval = false;
    entry.lastResolvedApprovalSignature = entry.lastApprovalSignature;
    entry.lastApprovalResolvedAt = Date.now();
    entry.lastApprovalSignature = null;
    entry.pendingRequestId = null;
    const option = entry.pendingOptions[optionIndex];

    if (option?.shortcutKey) {
      // Standard case: QwenRunner detected the prompt and parsed options with shortcut keys
      const normalizedShortcut = option.shortcutKey.trim().toLowerCase();
      let input: string;

      if (normalizedShortcut === "esc") {
        input = "\x1b";
      } else if (normalizedShortcut === "enter") {
        input = "\r";
      } else if (
        normalizedShortcut === "y" ||
        normalizedShortcut === "n" ||
        normalizedShortcut === "yes" ||
        normalizedShortcut === "no"
      ) {
        input = `${normalizedShortcut.startsWith("y") ? "y" : "n"}\r`;
      } else {
        input = option.shortcutKey;
      }

      log.debug(`${ts()} respondToSession: sending shortcut input: ${JSON.stringify(input)}`);
      this.writeTrace(entry, "pty-input", {
        text: input,
        optionIndex,
        reason: "approval-shortcut",
      });
      entry.pty.write(input);
    } else if (entry.pendingOptions.length > 0) {
      // Standard case: QwenRunner detected the prompt, use arrow navigation
      log.debug(`${ts()} respondToSession: using arrow navigation (10 up, ${optionIndex} down, enter)`);
      this.writeTrace(entry, "pty-input", {
        text: "\\x1b[A x10, \\x1b[B x" + optionIndex + ", \\r",
        optionIndex,
        reason: "approval-navigation",
      });
      for (let i = 0; i < 10; i += 1) {
        entry.pty.write("\x1b[A");
      }
      for (let i = 0; i < optionIndex; i += 1) {
        entry.pty.write("\x1b[B");
      }
      entry.pty.write("\r");
    } else {
      // Auto-detected approval from edge function: pendingOptions is empty
      // Send a direct y/n response to Qwen CLI
      const response = optionIndex === 0 ? "y" : "n";
      log.debug(`${ts()} respondToSession: auto-detected approval, sending "${response}"`);
      this.writeTrace(entry, "pty-input", {
        text: `${response}\\r`,
        optionIndex,
        reason: "approval-yes-no",
      });
      entry.pty.write(`${response}\r`);
    }

    entry.pendingOptions = [];
    entry.screen.reset();
    if (entry.status === "running") {
      // already running — no change needed
    }
    log.debug(`${ts()} respondToSession: cleared pendingOptions, returning true`);
    return { ok: true };
  }

  inputToSession(
    sessionId: string,
    text: string,
    modelName?: string,
    _planMode?: boolean,
    reasoningEffort?: string,
    approvalMode?: "full-auto" | "auto-edit" | "suggest",
    attachments?: string[],
  ): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return false;
    }

    if (entry.idleCompletionTimer) {
      clearTimeout(entry.idleCompletionTimer);
      entry.idleCompletionTimer = null;
    }

    if (entry.status === "idle") {
      if (modelName) {
        entry.modelName = modelName;
      }
      if (reasoningEffort) {
        entry.reasoningEffort = reasoningEffort;
      }
      if (approvalMode) {
        entry.approvalMode = approvalMode;
      }
      this.launchProcess(entry, text, true);
      return true;
    }

    if (modelName) {
      entry.modelName = modelName;
    }
    if (reasoningEffort) {
      entry.reasoningEffort = reasoningEffort;
    }
    if (approvalMode) {
      entry.approvalMode = approvalMode;
    }

    if (!entry.pty) {
      return false;
    }

    const fullText = buildPromptWithAttachments(text, attachments);
    this.writeTrace(entry, "pty-input", { text: fullText });
    entry.pty.write(`${fullText}\r`);
    return true;
  }

  cancelSession(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return false;
    }

    entry.status = "cancelled";
    this.emit("status", sessionId, "cancelled");

    if (entry.timeout) {
      clearTimeout(entry.timeout);
      entry.timeout = null;
    }
    if (entry.idleCompletionTimer) {
      clearTimeout(entry.idleCompletionTimer);
      entry.idleCompletionTimer = null;
    }
    this.setCommandActive(entry, false);
    this.flushPendingAssistantText(entry);

    if (!entry.pty) {
      const duration = Date.now() - entry.startedAt;
      this.emit("complete", sessionId, 130, duration);
      this.closeTrace(entry);
      this.sessions.delete(sessionId);
      return true;
    }

    try {
      entry.pty.kill();
    } catch {
      // Process may have already exited.
    }

    return true;
  }

  finishSession(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return false;
    }

    if (entry.timeout) {
      clearTimeout(entry.timeout);
      entry.timeout = null;
    }
    if (entry.idleCompletionTimer) {
      clearTimeout(entry.idleCompletionTimer);
      entry.idleCompletionTimer = null;
    }
    this.setCommandActive(entry, false);
    this.flushPendingAssistantText(entry);

    entry.pendingOptions = [];
    entry.pendingRequestId = null;
    entry.awaitingApproval = false;
    entry.lastApprovalSignature = null;
    entry.status = "completed";
    this.emit("status", sessionId, "completed");

    const duration = Date.now() - entry.startedAt;
    if (entry.pty) {
      const processPty = entry.pty;
      entry.pty = null;
      try {
        processPty.kill();
      } catch {
        // Process may already have exited.
      }
    }

    this.emit("complete", sessionId, 0, duration);
    this.closeTrace(entry);
    this.sessions.delete(sessionId);
    return true;
  }

  killAll(): void {
    for (const [id, entry] of this.sessions) {
      if (entry.pty === null) {
        // No active process — session already exited, clean up silently without emitting cancel.
        if (entry.timeout) clearTimeout(entry.timeout);
        if (entry.idleCompletionTimer) clearTimeout(entry.idleCompletionTimer);
        this.sessions.delete(id);
      } else {
        this.cancelSession(id);
      }
    }
  }

  private launchProcess(entry: SessionEntry, prompt: string, resume: boolean): void {
    const args = this.buildArgs(prompt, entry.approvalMode, resume, entry.providerSessionId);
    log.debug(`${ts()} session ${entry.id} - qwen ${args.join(" ")}`);
    log.debug(`${ts()} cwd: ${entry.projectPath}`);
    const isWin = process.platform === "win32";
    const resolvedQwen = isWin ? null : resolveExecutable("qwen");
    if (!existsSync(entry.projectPath)) {
      const detail = `Failed to launch Qwen PTY because the working directory does not exist: ${entry.projectPath}`;
      entry.status = "failed";
      this.writeTrace(entry, "launch-error", {
        shell: null,
        shellArgs: null,
        cwd: entry.projectPath,
        message: detail,
      });
      this.emit("error", entry.id, detail);
      this.emit("status", entry.id, "failed");
      this.emit("complete", entry.id, 1, Date.now() - entry.startedAt);
      this.closeTrace(entry);
      this.sessions.delete(entry.id);
      return;
    }
    this.writeTrace(entry, "launch", {
      resume,
      args,
      cwd: entry.projectPath,
      providerSessionId: entry.providerSessionId,
      resolvedExecutable: resolvedQwen,
    });

    const unixCommand = `exec ${buildShellCommand("qwen", args)}`;
    const unixShell = getShellLaunch();
    const shell = isWin ? "cmd.exe" : unixShell.shell;
    const shellArgs = isWin ? ["/c", "qwen", ...args] : unixShell.argsForCommand(unixCommand);

    if (!isWin && !resolvedQwen) {
      const detail =
        "Failed to launch Qwen PTY because the qwen binary could not be resolved from the login shell PATH.";
      entry.status = "failed";
      this.writeTrace(entry, "launch-error", {
        shell,
        shellArgs,
        cwd: entry.projectPath,
        message: detail,
      });
      this.emit("error", entry.id, detail);
      this.emit("status", entry.id, "failed");
      this.emit("complete", entry.id, 1, Date.now() - entry.startedAt);
      this.closeTrace(entry);
      this.sessions.delete(entry.id);
      return;
    }

    let processPty: pty.IPty;
    try {
      processPty = pty.spawn(shell, shellArgs, {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: entry.projectPath,
        env: sanitizePtyEnv(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail =
        `Failed to launch Qwen PTY (shell=${shell}, cwd=${entry.projectPath}). ${message}`;
      entry.status = "failed";
      this.writeTrace(entry, "launch-error", { shell, shellArgs, cwd: entry.projectPath, message });
      this.emit("error", entry.id, detail);
      this.emit("status", entry.id, "failed");
      this.emit("complete", entry.id, 1, Date.now() - entry.startedAt);
      this.closeTrace(entry);
      this.sessions.delete(entry.id);
      return;
    }

    entry.launchId += 1;
    const launchId = entry.launchId;
    entry.pty = processPty;
    entry.pendingOptions = [];
    entry.pendingRequestId = null;
    entry.awaitingApproval = false;
    entry.lastApprovalSignature = null;
    entry.status = "running";
    entry.prompt = prompt;
    this.emit("status", entry.id, "running");
    this.emit("providerSession", entry.id, entry.providerSessionId);

    processPty.onData((data: string) => {
      const current = this.sessions.get(entry.id);
      if (!current || current.launchId !== launchId || current.pty !== processPty) {
        return;
      }

      this.emit("output", entry.id, data);
      this.writeTrace(current, "pty-output", { data });

      current.screen.write(data);
      const clean = current.screen.getScreen();
      this.parseScreenBlocks(current, clean);
      const parsed = this.parsePrompt(clean);
      if (parsed) {
        // Auto-dismiss Qwen's "Do you want to connect VS Code to Qwen Code?"
        // prompt — always pick option 3 ("No, don't ask again") so the dialog
        // never interrupts a session again. Option 3 in Qwen's TUI is selected
        // by moving 2 steps down from the highlighted option 1 and pressing
        // Enter.
        if (/connect\s+VS\s*Code\s+to\s+Qwen\s*Code/i.test(parsed.contextText)) {
          log.debug(`${ts()} auto-declining VS Code integration prompt`);
          if (current.pty) {
            current.pty.write("\x1b[B");
            current.pty.write("\x1b[B");
            current.pty.write("\r");
            this.writeTrace(current, "pty-input", {
              text: "\\x1b[B x2, \\r",
              reason: "auto-decline-vscode-prompt",
            });
          }
          current.screen.reset();
        } else {
          this.raiseApproval(current, parsed.contextText, parsed.options);
          // Reset screen after approval so next turn starts fresh.
          current.screen.reset();
        }
      } else {
        const genericApprovalMessage = this.detectGenericApproval(clean);
        if (genericApprovalMessage) {
          this.raiseApproval(current, genericApprovalMessage, [
            { index: 0, label: "Accept", shortcutKey: "y" },
            { index: 1, label: "Reject", shortcutKey: "n" },
          ]);
          current.screen.reset();
        }
      }

      if (current.idleCompletionTimer) {
        clearTimeout(current.idleCompletionTimer);
        current.idleCompletionTimer = null;
      }

      if (!current.awaitingApproval && Date.now() - current.startedAt > 15_000) {
        current.idleCompletionTimer = setTimeout(() => {
          const latest = this.sessions.get(entry.id);
          if (
            !latest ||
            latest.launchId !== launchId ||
            latest.pty !== processPty ||
            latest.status !== "running" ||
            latest.awaitingApproval
          ) {
            return;
          }

          log.debug(`${ts()} session ${entry.id} - no PTY output for 15s, marking idle`);
          this.setCommandActive(latest, false);
          this.flushPendingAssistantText(latest);
          latest.status = "idle";
          latest.pendingOptions = [];
          latest.pendingRequestId = null;
          latest.awaitingApproval = false;
          latest.lastApprovalSignature = null;
          latest.pty = null;
          this.emit("status", entry.id, "idle");

          try {
            processPty.kill();
          } catch {
            // Process may already have exited.
          }
        }, 15_000);
      }
    });

    processPty.onExit(({ exitCode }) => {
      log.debug(`${ts()} session ${entry.id} exited code=${exitCode}`);
      const current = this.sessions.get(entry.id);
      if (!current) {
        return;
      }

      if (current.launchId !== launchId || current.pty !== processPty) {
        return;
      }

      current.pty = null;
      current.pendingOptions = [];
      current.pendingRequestId = null;
      current.awaitingApproval = false;
      current.lastApprovalSignature = null;
      this.setCommandActive(current, false);
      if (current.idleCompletionTimer) {
        clearTimeout(current.idleCompletionTimer);
        current.idleCompletionTimer = null;
      }

      const duration = Date.now() - current.startedAt;
      current.exitCode = exitCode;

      if (current.status === "cancelled") {
        if (current.timeout) {
          clearTimeout(current.timeout);
          current.timeout = null;
        }
        this.emit("complete", entry.id, exitCode, duration);
        this.closeTrace(current);
        this.sessions.delete(entry.id);
        return;
      }

      if (exitCode === 0) {
        this.flushPendingAssistantText(current);
        current.status = "idle";
        this.emit("status", entry.id, "idle");
        return;
      }

      if (current.timeout) {
        clearTimeout(current.timeout);
        current.timeout = null;
      }

      current.status = "failed";
      this.emit("status", entry.id, "failed");
      this.emit("complete", entry.id, exitCode, duration);
      this.closeTrace(current);
      this.sessions.delete(entry.id);
    });
  }

  private buildArgs(
    prompt: string,
    mode: "full-auto" | "auto-edit" | "suggest",
    resume: boolean,
    providerSessionId: string,
  ): string[] {
    const args: string[] = ["--approval-mode", this.mapApprovalMode(mode)];

    if (resume) {
      args.push("--resume", providerSessionId);
    } else {
      args.push("--session-id", providerSessionId);
    }

    args.push("-i", prompt);
    return args;
  }

  private mapApprovalMode(mode: "full-auto" | "auto-edit" | "suggest"): string {
    if (mode === "full-auto") {
      return "yolo";
    }
    if (mode === "auto-edit") {
      return "auto-edit";
    }
    return "default";
  }

  private normalizeApprovalLine(line: string): string {
    return line
      .replace(/^\s*[│|]\s?/, "")
      .replace(/\s?[│|]\s*$/, "")
      .replace(/^\s*[›❯>]\s*/, "")
      .replace(/^\s*[?]\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private isApprovalNoiseLine(line: string): boolean {
    if (!line) {
      return true;
    }

    return (
      /^(?:approval|permission)\s+required$/i.test(line) ||
      /^apply\s+this\s+change\??$/i.test(line) ||
      /^\??\s*for shortcuts\b/i.test(line) ||
      /^type your message(?:\s+or\s+@path\/to\/file)?$/i.test(line) ||
      /^\d+(?:\.\d+)?%\s+context used$/i.test(line) ||
      /^waiting\s+for\s+(?:approval|user|confirmation)/i.test(line) ||
      /^(?:thinking|analyzing|reasoning|working|loading|searching|mining)\b/i.test(line) ||
      /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)
    );
  }

  private isApprovalActionLine(line: string): boolean {
    return (
      /^(?:Edit|Write|WriteFile|MultiEdit|Replace|CreateFile|ReadFile|ReadFolder|ReadManyFiles|ListFiles|ListDirectory|Grep|Glob|Search|SearchText|Shell|Bash|Run|Fetch|WebFetch)\b/.test(
        line,
      ) ||
      /^(?:Command|File|Path)\s*:/i.test(line) ||
      /(?:^|[ "'`])(?:[A-Za-z]:\\|\/)?[\w./\\-]+\.[A-Za-z0-9]+(?::\d+)?(?:[ "'`]|$)/.test(line) ||
      /(?:powershell|cmd(?:\.exe)?|bash|sh|npm|pnpm|yarn|node|python|git|sed|cat|rm|mv|cp)\b/i.test(
        line,
      )
    );
  }

  private isApprovalPromptLine(line: string): boolean {
    return (
      /do\s+you\s+want\s+to\s+(?:proceed|continue|apply)/i.test(line) ||
      /confirm\s+this\s+action/i.test(line) ||
      /\b(?:approve|allow|confirm|continue|proceed|apply|autoriser|confirmer|continuer|valider)\b/i.test(
        line,
      ) && /[?]\s*$/.test(line)
    );
  }

  private isExplicitApprovalChoiceLine(line: string): boolean {
    return (
      /\b(?:y\/n|yes\/no|accept\/reject|approve\/reject|allow\/deny)\b/i.test(line) ||
      /^\s*(?:accept|reject|approve|deny|yes|no)\s*$/i.test(line)
    );
  }

  private isOrdinaryAssistantLine(line: string): boolean {
    return (
      /\b(?:successful|successfully|completed|done|finished|imported|added|removed|updated|created|fixed)\b/i.test(
        line,
      ) ||
      /^the\s+(?:edit|change|component|file)\s+/i.test(line) ||
      /^i(?:'| )?ve\s+/i.test(line)
    );
  }

  private isTransientStatusText(text: string): boolean {
    const normalized = this.normalizeApprovalLine(text);
    if (!normalized) {
      return false;
    }

    const looksLikeStandaloneStatusPhrase =
      !/[.!?]$/.test(normalized) &&
      normalized.split(/\s+/).length <= 8 &&
      /^(?:[A-Z][a-z]+ing|[a-z]+ing)\b/.test(normalized) &&
      !/\b(?:component|function|variable|class|import|export|file|code|error)\b/i.test(
        normalized,
      );

    return (
      /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(normalized) ||
      /\([^)]*\d+\s*s[^)]*\)/i.test(normalized) ||
      /\b\d+\s*s\b/i.test(normalized) ||
      /\u2026|\.{3}/.test(normalized) ||
      looksLikeStandaloneStatusPhrase ||
      /^(just a moment|one moment|finding|searching|looking|checking|reading|opening|locating|reviewing|analyzing|analysing|updating|loading|preparing|scanning|inspecting|exploring|optimizing|optimising|compiling|painting|polishing|tuning|stitching|untangling)\b/i.test(
        normalized,
      )
    );
  }

  private cleanBoxInnerLine(line: string): string {
    return line
      .replace(/^\s*│\s?/, "")
      .replace(/\s?│\s*$/, "")
      .replace(/\s+$/, "");
  }

  private extractSurroundingBoxLines(
    lines: string[],
    centerIndex: number,
  ): string[] | null {
    let top = -1;
    for (let i = centerIndex; i >= Math.max(0, centerIndex - 30); i -= 1) {
      if (/^\s*╭/.test(lines[i] ?? "")) {
        top = i;
        break;
      }
    }
    if (top < 0) {
      return null;
    }

    let bottom = -1;
    for (let i = centerIndex; i < Math.min(lines.length, centerIndex + 40); i += 1) {
      if (/^\s*╰/.test(lines[i] ?? "")) {
        bottom = i;
        break;
      }
    }
    if (bottom < 0 || bottom <= top) {
      return null;
    }

    return lines.slice(top + 1, bottom).map((line) => this.cleanBoxInnerLine(line));
  }

  private extractCodePreviewFromBox(
    lines: string[],
    toolLineIndex: number,
    tool: string,
    args: string,
    filePath: string,
  ): { body: string; metadata: Record<string, unknown> } | null {
    const innerLines = this.extractSurroundingBoxLines(lines, toolLineIndex);
    if (!innerLines || innerLines.length === 0) {
      return null;
    }

    const toolLineIndexInBox = innerLines.findIndex((line) => {
      const normalized = this.normalizeApprovalLine(line);
      return normalized.includes(tool) && normalized.includes(filePath);
    });

    if (toolLineIndexInBox < 0) {
      return null;
    }

    const previewLines: string[] = [];
    for (let i = toolLineIndexInBox + 1; i < innerLines.length; i += 1) {
      const raw = innerLines[i];
      const normalized = this.normalizeApprovalLine(raw);
      if (!normalized) {
        if (previewLines.length > 0) {
          break;
        }
        continue;
      }
      if (
        this.isApprovalNoiseLine(normalized) ||
        /^\s*\d+\.\s/.test(normalized) ||
        /^Apply this change\??$/i.test(normalized) ||
        /^(?:Grep|Glob|Shell|ReadFile|ReadFolder|ReadManyFiles|ListFiles|ListDirectory|Edit|Write|WriteFile|FindFiles|Search|SearchText|FileSystem|Bash|Run|MultiEdit|Replace|Todo|Task|Fetch|WebFetch|CreateFile)\b/.test(
          normalized,
        )
      ) {
        break;
      }
      previewLines.push(raw.trim());
    }

    if (previewLines.length === 0) {
      return null;
    }

    const diffLines: string[] = [];
    for (const line of previewLines) {
      const withoutPrefix = line.startsWith(`${filePath}:`)
        ? line.slice(filePath.length + 1).trim()
        : line.trim();
      if (!withoutPrefix) {
        continue;
      }
      if (withoutPrefix.includes("=>")) {
        const [before, after] = withoutPrefix.split(/\s*=>\s*/, 2);
        if (before?.trim()) diffLines.push(`- ${before.trim()}`);
        if (after?.trim()) diffLines.push(`+ ${after.trim()}`);
        continue;
      }
      diffLines.push(withoutPrefix);
    }

    const body = diffLines.join("\n").trim();
    if (!body) {
      return null;
    }

    return {
      body,
      metadata: {
        tool,
        filePath,
        format: body.split("\n").every((line) => /^[-+]/.test(line)) ? "diff" : undefined,
        changeDescription: args,
        lineCount: body.split("\n").length,
      },
    };
  }

  private updateLastActionContext(
    entry: SessionEntry,
    kind: SessionReadableBlockIngest["kind"],
    title: string | null,
    body: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (kind === "code") {
      const tool = typeof metadata?.tool === "string" ? metadata.tool : "Edit";
      const filePath =
        typeof metadata?.filePath === "string" ? metadata.filePath : title;
      entry.lastActionTitle = filePath ? `${tool} ${filePath}` : tool;
      entry.lastActionMessage = body;
      return;
    }

    if (kind === "command") {
      const tool = typeof metadata?.tool === "string" ? metadata.tool : "Command";
      entry.lastActionTitle = `${tool}: ${body.slice(0, 140)}`;
      entry.lastActionMessage = body;
      return;
    }

    if (kind === "path") {
      const tool = typeof metadata?.tool === "string" ? metadata.tool : "File";
      entry.lastActionTitle = `${tool} ${body.split("\n")[0] ?? ""}`.trim();
      entry.lastActionMessage = body;
    }
  }

  private approvalDisplayNeedsActionFallback(
    parts: { title: string | null; message: string },
  ): boolean {
    const title = (parts.title ?? "").trim();
    const messageLines = parts.message
      .split("\n")
      .map((line) => this.normalizeApprovalLine(line))
      .filter(Boolean);

    if (title && this.isApprovalActionLine(title)) {
      return false;
    }
    if (messageLines.some((line) => this.isApprovalActionLine(line))) {
      return false;
    }
    if (!title && /^Qwen requires confirmation$/i.test(parts.message.trim())) {
      return true;
    }
    if (/^(?:approval|permission)\s+required$/i.test(title || parts.message.trim())) {
      return true;
    }
    return true;
  }

  private extractLatestActionContextFromScreen(
    clean: string,
  ): { title: string; message: string } | null {
    const lines = clean.split("\n");
    const toolLineRe =
      /[│|]?\s*([?✓✎⊶⧖⚡✗✖✔●])\s+(Grep|Glob|Shell|ReadFile|ReadFolder|ReadManyFiles|ListFiles|ListDirectory|Edit|Write|WriteFile|FindFiles|Search|SearchText|FileSystem|Bash|Run|MultiEdit|Replace|Todo|Task|Fetch|WebFetch|CreateFile)\b([^\n]*?)(?:\s*[│|])?$/;

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const rawLine = lines[i];
      const match = rawLine.match(toolLineRe);
      if (!match) continue;
      const [, icon, tool, rawArgs] = match;
      if (icon === "⊶" || icon === "⧖" || icon === "⚡") continue;

      const args = rawArgs
        .trim()
        .replace(/[←→↵]\s*$/, "")
        .replace(/…$/, "")
        .trim();
      if (!args) continue;

      const editLike = /^(Edit|Write|WriteFile|MultiEdit|Replace|CreateFile)$/.test(tool);
      const readLike = /^(ReadFile|ReadFolder|ReadManyFiles|ListFiles|ListDirectory)$/.test(tool);

      if (editLike) {
        const filePath = (args.match(/^([^\s:]+)/) ?? [null, args])[1] ?? args;
        const preview = this.extractCodePreviewFromBox(lines, i, tool, args, filePath);
        return {
          title: `${tool} ${filePath}`.trim(),
          message: preview?.body || args,
        };
      }

      if (readLike) {
        const filePath = (args.match(/^['""]?([^'""\s]+)['""]?/) ?? [null, args])[1] ?? args;
        return {
          title: `${tool} ${filePath}`.trim(),
          message: filePath,
        };
      }

      return {
        title: `${tool}: ${args.slice(0, 140)}`.trim(),
        message: args,
      };
    }

    return null;
  }

  private preparePromptDetectionLine(line: string): string {
    return this.cleanBoxInnerLine(line)
      .replace(/\s*[←→↵]\s*$/, "")
      .trimEnd();
  }

  private buildApprovalDisplay(contextText: string): { title: string | null; message: string } {
    const lines = contextText
      .split("\n")
      .map((line) => this.normalizeApprovalLine(line))
      .filter(Boolean);

    const filtered = lines.filter((line) => !this.isApprovalNoiseLine(line));
    const actionLine = filtered.find((line) => this.isApprovalActionLine(line)) ?? null;

    if (actionLine) {
      const messageLines = filtered.filter((line) => line !== actionLine);
      return {
        title: actionLine.length <= 120 ? actionLine : `${actionLine.slice(0, 117)}...`,
        message: messageLines.join("\n") || actionLine,
      };
    }

    if (filtered.length >= 2 && filtered[0].length <= 80) {
      return {
        title: filtered[0],
        message: filtered.slice(1).join("\n"),
      };
    }

    const fallback = filtered[0] ?? lines[0] ?? "Qwen requires confirmation";
    return {
      title: null,
      message: fallback.length <= 220 ? fallback : `${fallback.slice(0, 217)}...`,
    };
  }

  /**
   * Extracts the content of the approval box surrounding the options block.
   * Looks upward from the options lines until a ╭ border is found, and joins
   * the inner lines (stripping "│" borders and excess whitespace). This keeps
   * the tool header (e.g. "?  Edit App.tsx:…") and the diff preview so the
   * mobile approval popup can display what exactly is being asked.
   */
  private extractApprovalBoxContent(
    lines: string[],
    blockStart: number,
    blockEnd: number,
  ): string | null {
    let top = -1;
    for (let i = blockStart - 1; i >= Math.max(0, blockStart - 120); i -= 1) {
      const raw = lines[i];
      if (/^\s*╭/.test(raw)) {
        top = i;
        break;
      }
    }
    if (top < 0) return null;
    let bottom = -1;
    for (let i = blockEnd + 1; i < Math.min(lines.length, blockEnd + 40); i += 1) {
      const raw = lines[i];
      if (/^\s*╰/.test(raw)) {
        bottom = i;
        break;
      }
    }
    if (bottom < 0) bottom = Math.min(lines.length - 1, blockEnd + 20);

    const inner: string[] = [];
    for (let i = top + 1; i < bottom; i += 1) {
      const raw = lines[i];
      let cleaned = raw
        .replace(/^\s*│\s?/, "")
        .replace(/\s?│\s*$/, "")
        .replace(/\s+$/, "");
      cleaned = cleaned.replace(/^\s*›\s*/, "");
      if (/^\s*$/.test(cleaned)) {
        if (inner.length && inner[inner.length - 1] !== "") inner.push("");
        continue;
      }
      if (this.isApprovalNoiseLine(this.normalizeApprovalLine(cleaned)) && inner.length === 0) {
        continue;
      }
      // Stop before numbered choice options (they're already sent as options).
      if (/^\s*\d+\.\s/.test(cleaned)) break;
      if (/^Apply this change\??$/i.test(cleaned.trim())) {
        inner.push(cleaned.trim());
        break;
      }
      inner.push(cleaned);
    }
    // Drop trailing blanks.
    while (inner.length && inner[inner.length - 1] === "") inner.pop();
    return inner.length ? inner.join("\n") : null;
  }

  private parsePrompt(text: string): { contextText: string; options: ParsedOption[] } | null {
    const rawLines = text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .slice(-80)
      .map((line) => line.trimEnd());
    const lines = rawLines.map((line) => this.preparePromptDetectionLine(line));
    const optionMatcher =
      /^(?:\s*(?:\u203a|\u276f|>|->|\*)\s*)?(\d+)[.)]\s+(.+?)(?:\s+\(([\w-]+)\))?\s*$/;
    const hasCursorPrefix = (line: string) =>
      /^\s*(?:\u203a|\u276f|>|->|\*)\s*/.test(line);
    const isDescriptionLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || optionMatcher.test(trimmed)) {
        return false;
      }
      return (
        /^\s{2,}\S/.test(line) ||
        /^[a-z]/.test(trimmed) ||
        /\b(recommended|default|faster|safer|impact|tradeoff)\b/i.test(trimmed)
      );
    };
    let blockStart = -1;
    let blockHasCursor = false;
    let blockOptions: ParsedOption[] = [];
    let bestStart = -1;
    let bestEnd = -1;
    let bestHasCursor = false;
    let bestOptions: ParsedOption[] = [];
    const commitBlock = (endExclusive: number) => {
      if (blockOptions.length >= 2) {
        bestStart = blockStart;
        bestEnd = endExclusive - 1;
        bestHasCursor = blockHasCursor;
        bestOptions = [...blockOptions];
      }
      blockStart = -1;
      blockHasCursor = false;
      blockOptions = [];
    };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const match = line.match(optionMatcher);
      if (!match) {
        if (blockOptions.length > 0 && isDescriptionLine(line)) {
          continue;
        }
        if (blockOptions.length > 0) {
          commitBlock(index);
        }
        continue;
      }
      const optionNumber = Number(match[1]);
      const label = match[2].trim();
      const shortcutKey = match[3] ?? null;
      const hasCursor = hasCursorPrefix(line);
      if (!label) {
        if (blockOptions.length > 0) {
          commitBlock(index);
        }
        continue;
      }
      if (blockOptions.length === 0) {
        if (optionNumber !== 1) {
          continue;
        }
        blockStart = index;
        blockHasCursor = hasCursor;
        blockOptions.push({
          index: 0,
          label,
          shortcutKey,
        });
        continue;
      }
      const expectedNumber = blockOptions.length + 1;
      if (optionNumber !== expectedNumber) {
        commitBlock(index);
        if (optionNumber !== 1) {
          continue;
        }
        blockStart = index;
        blockHasCursor = hasCursor;
        blockOptions.push({
          index: 0,
          label,
          shortcutKey,
        });
        continue;
      }
      blockHasCursor ||= hasCursor;
      blockOptions.push({
        index: blockOptions.length,
        label,
        shortcutKey,
      });
    }
    if (blockOptions.length > 0) {
      commitBlock(lines.length);
    }
    if (bestOptions.length < 2 || bestStart === -1 || bestEnd === -1) {
      return null;
    }
    const contextLines: string[] = [];
    for (let index = bestStart - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) {
        if (contextLines.length > 0) {
          break;
        }
        continue;
      }
      contextLines.unshift(line);
      if (contextLines.length >= 8) {
        break;
      }
    }
    const contextText = contextLines.join("\n").trim();
    const region = lines
      .slice(Math.max(0, bestStart - 8), bestEnd + 1)
      .join("\n")
      .trim();
    const lastContextLine = contextLines.at(-1) ?? "";
    const looksInteractive =
      bestHasCursor ||
      bestOptions.some((option) => option.shortcutKey) ||
      /[?]\s*$/.test(lastContextLine) ||
      /\b(recommended|select one|choose one|pick one|press enter to submit|esc to cancel|answer the following|question)\b/i.test(
        `${contextText}\n${region}`,
      ) ||
      /\b(choose|pick|select|which|prefer|option|recommended|continue|confirm|allow|approve|answer|respond|question|what should i|would you like|how should i|autoriser|choisir|quelle option|quel choix|continuer|confirmer|repondre|r??pondre)\b/i.test(
        `${contextText}\n${region}`,
      );
    if (!looksInteractive) {
      return null;
    }
    const boxContent = this.extractApprovalBoxContent(rawLines, bestStart, bestEnd);
    return {
      contextText: boxContent ?? contextText ?? region,
      options: bestOptions,
    };
  }

  private detectGenericApproval(text: string): string | null {
    const normalized = text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();

    if (!normalized) {
      return null;
    }

    const approvalPatterns = [
      /waiting\s+for\s+user\s+confirmation/i,
      /waiting\s+for\s+approval/i,
      /user\s+confirmation\s+required/i,
      /approval\s+required/i,
      /confirm\s+this\s+action/i,
      /do\s+you\s+want\s+to\s+(proceed|continue|apply)/i,
    ];

    if (!approvalPatterns.some((pattern) => pattern.test(normalized))) {
      return null;
    }

    const lines = normalized
      .split("\n")
      .map((line) => this.normalizeApprovalLine(line))
      .filter(Boolean);
    const tailLines = lines.slice(-12);
    const strongPromptPresent = tailLines.some((line) =>
      approvalPatterns.some((pattern) => pattern.test(line)),
    );
    const explicitChoicePresent = tailLines.some((line) => this.isExplicitApprovalChoiceLine(line));
    const promptQuestionPresent = tailLines.some((line) => this.isApprovalPromptLine(line));

    if (!strongPromptPresent && !explicitChoicePresent && !promptQuestionPresent) {
      return null;
    }

    if (
      !explicitChoicePresent &&
      tailLines.some((line) => this.isOrdinaryAssistantLine(line))
    ) {
      return null;
    }

    const relevantLines = tailLines.filter(
      (line) => !this.isApprovalNoiseLine(line) && line.length > 3,
    );
    const actionLine = relevantLines.find((line) => this.isApprovalActionLine(line));
    const promptLine = relevantLines.find((line) => this.isApprovalPromptLine(line));
    const contextLine =
      actionLine ??
      promptLine ??
      (explicitChoicePresent ? relevantLines[0] : null) ??
      lines[0] ??
      "Qwen requires confirmation";

    return contextLine.length > 220 ? `${contextLine.slice(0, 217)}...` : contextLine;
  }

  private raiseApproval(
    entry: SessionEntry,
    message: string,
    options: ParsedOption[],
  ): void {
    if (entry.approvalMode === "full-auto") {
      log.debug(`${ts()} auto-approving prompt in YOLO mode`);
      entry.pendingOptions = options;
      entry.pendingRequestId = null;
      entry.awaitingApproval = false;
      entry.lastResolvedApprovalSignature = entry.lastApprovalSignature;
      entry.lastApprovalResolvedAt = Date.now();
      entry.lastApprovalSignature = null;
      this.respondToDetectedApproval(entry, 0);
      return;
    }

    const textParts = this.extractApprovalTextParts(message);
    const screenActionContext = this.extractLatestActionContextFromScreen(entry.screen.getScreen());
    const finalTextParts =
      this.approvalDisplayNeedsActionFallback(textParts) &&
      (screenActionContext?.title || entry.lastActionTitle)
        ? {
            title: screenActionContext?.title ?? entry.lastActionTitle,
            message:
              textParts.message.trim() &&
              !/^(?:approval|permission)\s+required$/i.test(textParts.message.trim()) &&
              textParts.message.trim() !== (screenActionContext?.title ?? entry.lastActionTitle)
                ? textParts.message
                : screenActionContext?.message ??
                  entry.lastActionMessage ??
                  entry.lastActionTitle ??
                  "Qwen requires confirmation",
          }
        : textParts;
    const signature = `${finalTextParts.title ?? ""}::${finalTextParts.message}::${options
      .map((option) => `${option.index}:${option.label}:${option.shortcutKey ?? ""}`)
      .join("|")}`;
    const recentlyResolvedSameApproval =
      entry.lastResolvedApprovalSignature === signature &&
      Date.now() - entry.lastApprovalResolvedAt < 5_000;

    if (recentlyResolvedSameApproval) {
      log.debug(`${ts()} suppressing duplicate approval redraw`);
      return;
    }

    if (entry.awaitingApproval && entry.lastApprovalSignature === signature) {
      return;
    }

    log.debug(`${ts()} approval detected (${options.length} opts)`);
    entry.requestCounter += 1;
    entry.pendingOptions = options;
    entry.pendingRequestId = `${entry.id}-approval-${entry.requestCounter}`;
    entry.awaitingApproval = true;
    entry.lastApprovalSignature = signature;
    entry.status = "running";
    this.emit("status", entry.id, "running");
    this.emit(
      "approval",
      entry.id,
      entry.pendingRequestId,
      finalTextParts.title,
      finalTextParts.message,
      options,
    );
  }

  private respondToDetectedApproval(entry: SessionEntry, optionIndex: number): void {
    if (!entry.pty) {
      return;
    }

    const option = entry.pendingOptions[optionIndex];
    if (option?.shortcutKey) {
      const normalizedShortcut = option.shortcutKey.trim().toLowerCase();
      let input: string;

      if (normalizedShortcut === "esc") {
        input = "\x1b";
      } else if (normalizedShortcut === "enter") {
        input = "\r";
      } else if (
        normalizedShortcut === "y" ||
        normalizedShortcut === "n" ||
        normalizedShortcut === "yes" ||
        normalizedShortcut === "no"
      ) {
        input = `${normalizedShortcut.startsWith("y") ? "y" : "n"}\r`;
      } else {
        input = option.shortcutKey;
      }

      entry.pty.write(input);
      this.writeTrace(entry, "pty-input", {
        text: input,
        optionIndex,
        reason: "auto-approval-shortcut",
      });
    } else if (entry.pendingOptions.length > 0) {
      this.writeTrace(entry, "pty-input", {
        text: "\\x1b[A x10, \\x1b[B x" + optionIndex + ", \\r",
        optionIndex,
        reason: "auto-approval-navigation",
      });
      for (let i = 0; i < 10; i += 1) {
        entry.pty.write("\x1b[A");
      }
      for (let i = 0; i < optionIndex; i += 1) {
        entry.pty.write("\x1b[B");
      }
      entry.pty.write("\r");
    } else {
      this.writeTrace(entry, "pty-input", {
        text: `${optionIndex === 0 ? "y" : "n"}\\r`,
        optionIndex,
        reason: "auto-approval-yes-no",
      });
      entry.pty.write(`${optionIndex === 0 ? "y" : "n"}\r`);
    }

    entry.pendingOptions = [];
    entry.pendingRequestId = null;
  }

  private extractApprovalTextParts(
    contextText: string,
  ): { title: string | null; message: string } {
    return this.buildApprovalDisplay(contextText);
  }

  private emitBlock(
    entry: SessionEntry,
    kind: SessionReadableBlockIngest["kind"],
    title: string | null,
    body: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.updateLastActionContext(entry, kind, title, body, metadata);
    const block: Omit<SessionReadableBlockIngest, "seq" | "occurredAt"> = {
      kind,
      body,
      ...(title ? { title } : {}),
      ...(metadata ? { metadata } : {}),
    };
    this.emit("readableBlock", entry.id, block);
  }

  private flushPendingAssistantText(entry: SessionEntry): void {
    // Flush any legacy single-text pending
    if (entry.assistantEmitTimer) {
      clearTimeout(entry.assistantEmitTimer);
      entry.assistantEmitTimer = null;
    }
    // Flush all pending text blocks
    for (const [key, pending] of entry.pendingTextBlocks) {
      if (pending.timer) { clearTimeout(pending.timer); }
      if (pending.text && !entry.emittedTextBodies.has(pending.text)) {
        this.emitBlock(entry, "text", null, pending.text);
        entry.emittedTextBodies.add(pending.text);
      }
    }
    entry.pendingTextBlocks.clear();
    entry.pendingAssistantText = "";
  }

  private normalizeTextGrowthCandidate(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private commonPrefixLength(left: string, right: string): number {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) {
      index += 1;
    }
    return index;
  }

  private commonSuffixLength(left: string, right: string): number {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (
      index < limit &&
      left[left.length - 1 - index] === right[right.length - 1 - index]
    ) {
      index += 1;
    }
    return index;
  }

  private sharedLeadingWordCount(left: string, right: string): number {
    const leftWords = left.split(/\s+/).filter(Boolean);
    const rightWords = right.split(/\s+/).filter(Boolean);
    const limit = Math.min(leftWords.length, rightWords.length);
    let index = 0;
    while (index < limit && leftWords[index] === rightWords[index]) {
      index += 1;
    }
    return index;
  }

  private sharedTrailingWordCount(left: string, right: string): number {
    const leftWords = left.split(/\s+/).filter(Boolean);
    const rightWords = right.split(/\s+/).filter(Boolean);
    const limit = Math.min(leftWords.length, rightWords.length);
    let index = 0;
    while (
      index < limit &&
      leftWords[leftWords.length - 1 - index] === rightWords[rightWords.length - 1 - index]
    ) {
      index += 1;
    }
    return index;
  }

  private findPendingTextBlockKey(entry: SessionEntry, text: string): string | null {
    const normalized = this.normalizeTextGrowthCandidate(text);
    if (!normalized) {
      return null;
    }

    for (const [key, pending] of entry.pendingTextBlocks) {
      const existing = this.normalizeTextGrowthCandidate(pending.text);
      if (!existing) {
        continue;
      }

      if (normalized.startsWith(existing) || existing.startsWith(normalized)) {
        return key;
      }

      if (
        this.commonPrefixLength(normalized, existing) >= 24 ||
        this.sharedLeadingWordCount(normalized, existing) >= 5 ||
        this.commonSuffixLength(normalized, existing) >= 48 ||
        this.sharedTrailingWordCount(normalized, existing) >= 6
      ) {
        return key;
      }
    }

    return null;
  }

  private hasEmittedEquivalentText(entry: SessionEntry, text: string): boolean {
    const normalized = this.normalizeTextGrowthCandidate(text);
    if (!normalized) {
      return true;
    }

    for (const emitted of entry.emittedTextBodies) {
      const existing = this.normalizeTextGrowthCandidate(emitted);
      if (!existing) {
        continue;
      }

      if (
        normalized === existing ||
        ((normalized.startsWith(existing) || existing.startsWith(normalized)) &&
          Math.min(normalized.length, existing.length) >= 24) ||
        this.sharedLeadingWordCount(normalized, existing) >= 5 ||
        this.commonSuffixLength(normalized, existing) >= 48 ||
        this.sharedTrailingWordCount(normalized, existing) >= 6
      ) {
        return true;
      }
    }

    return false;
  }

  private setCommandActive(entry: SessionEntry, active: boolean): void {
    if (entry.commandActive === active) {
      return;
    }

    entry.commandActive = active;
    this.emitBlock(entry, "command", "Running commands", "Running commands", {
      active,
      transient: true,
      state: active ? "running" : "completed",
      displayMode: "status-only",
    });
  }

  private hasActiveCommandPanels(lines: string[]): boolean {
    return lines.some((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return false;
      }

      return (
        /(?:^|[\s\u2502|])[\u22F6\u22F7]\s+Agent\b/.test(trimmed) ||
        /\u25CF\s+Running\b/.test(trimmed) ||
        /\+\d+\s+more tool calls\b/i.test(trimmed)
      );
    });
  }

  /**
   * Parses the current cleaned PTY screen to extract displayable blocks.
   * - Tool calls (Grep/Glob/ReadFile/Shell/Edit/Write) → command/code/path blocks.
   * - Assistant text (lines starting with ✦) → text block (debounced).
   * - Spinner status text (⠋ Looking for a misplaced semicolon…) → thinking block.
   * Deduplicates via signatures stored on the entry.
   */
  private parseScreenBlocks(entry: SessionEntry, clean: string): void {
    const lines = clean.split("\n");
    this.setCommandActive(entry, this.hasActiveCommandPanels(lines));

    // ── 1. Tool calls ────────────────────────────────────────────────────────
    // Pattern: "│ ✓  ToolName args…" inside boxes.
    // We only emit on completed icons (✓ ✎ ✔ ✗ ✖), not in-progress (⊶ ⧖ ⚡).
    const toolLineRe =
      /[│|]\s*([✓✎⊶⧖⚡✗✖✔●])\s+(Grep|Glob|Shell|ReadFile|ReadFolder|ReadManyFiles|ListFiles|ListDirectory|Edit|Write|WriteFile|FindFiles|Search|SearchText|FileSystem|Bash|Run|MultiEdit|Replace|Todo|Task|Fetch|WebFetch|CreateFile)\b([^\n]*?)(?:\s*[│|])?$/;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const rawLine = lines[lineIndex];
      const match = rawLine.match(toolLineRe);
      if (!match) continue;
      const [, icon, tool, rawArgs] = match;
      if (icon === "⊶" || icon === "⧖" || icon === "⚡") continue;
      const args = rawArgs.trim().replace(/…$/, "").trim();
      if (!args) continue;
      const signature = `tool:${tool}:${args}`;
      if (entry.emittedToolSignatures.has(signature)) continue;
      entry.emittedToolSignatures.add(signature);

      const editLike = /^(Edit|Write|WriteFile|MultiEdit|Replace|CreateFile)$/.test(tool);
      const readLike = /^(ReadFile|ReadFolder|ReadManyFiles|ListFiles|ListDirectory)$/.test(tool);
      if (editLike) {
        const filePath = (args.match(/^([^\s:]+)/) ?? [null, args])[1]!;
        const preview = this.extractCodePreviewFromBox(lines, lineIndex, tool, args, filePath);
        this.emitBlock(
          entry,
          "code",
          filePath,
          preview?.body ?? args,
          preview?.metadata ?? { tool, filePath, changeDescription: args },
        );
      } else if (readLike) {
        const filePath = (args.match(/^['""]?([^'""\s]+)['""]?/) ?? [null, args])[1]!;
        this.emitBlock(entry, "path", tool, filePath, { tool });
      } else {
        this.emitBlock(entry, "command", tool, args, { tool });
      }
    }

    // ── 2. Assistant text ────────────────────────────────────────────────────
    // The screen may show multiple ✦ blocks (chat history). Each is a separate
    // text block. We collect all of them, track the longest capture per prefix
    // key, and emit each once after 3s of stability.
    const assistantBlocks = [
      ...this.collectAssistantBlocks(lines, entry).map((text) => ({ text, keyHint: null as string | null })),
      ...this.collectRenderedAssistantBlocks(lines).map((text) => ({
        text,
        keyHint: "rendered-screen-block",
      })),
    ];

    for (const { text, keyHint } of assistantBlocks) {
      if (!text || this.hasEmittedEquivalentText(entry, text)) continue;

      const existingKey = keyHint ?? this.findPendingTextBlockKey(entry, text);
      const key =
        existingKey ??
        `text:${entry.pendingTextBlocks.size}:${this.normalizeTextGrowthCandidate(text).slice(0, 80)}`;
      const existing = existingKey ? entry.pendingTextBlocks.get(existingKey) : null;

      if (existing) {
        if (text.length > existing.text.length) {
          existing.text = text;
          // Reset stability timer.
          if (existing.timer) clearTimeout(existing.timer);
          existing.timer = setTimeout(() => {
            const latest = this.sessions.get(entry.id);
            if (!latest) return;
            const slot = latest.pendingTextBlocks.get(key);
            if (slot && !latest.emittedTextBodies.has(slot.text)) {
              this.emitBlock(latest, "text", null, slot.text);
              latest.emittedTextBodies.add(slot.text);
            }
            latest.pendingTextBlocks.delete(key);
          }, 3000);
        }
        // Text is shorter or same — ignore (reflow artifact).
      } else {
        // New text block — start tracking.
        const timer = setTimeout(() => {
          const latest = this.sessions.get(entry.id);
          if (!latest) return;
          const slot = latest.pendingTextBlocks.get(key);
          if (slot && !latest.emittedTextBodies.has(slot.text)) {
            this.emitBlock(latest, "text", null, slot.text);
            latest.emittedTextBodies.add(slot.text);
          }
          latest.pendingTextBlocks.delete(key);
        }, 3000);
        entry.pendingTextBlocks.set(key, { text, timer });
      }
    }

    // Qwen spinner labels stay internal. The mobile client now uses the same
    // shared transient indicators as Codex/Claude instead of rendering
    // Qwen's textual thinking output in the conversation transcript.
  }

  private isTuiNoiseLine(text: string): boolean {
    if (!text) return true;
    const t = text.trim();
    if (!t) return true;
    if (/for shortcuts\b/i.test(t)) return true;
    if (/context used\b/i.test(t)) return true;
    if (/Type your message/i.test(t)) return true;
    if (/Press\s+[↑↓]/i.test(t)) return true;
    if (/esc to cancel/i.test(t)) return true;
    if (/Press\s+(?:\u2191|\u2193)/i.test(t)) return true;
    if (/^●\s+Update successful\b/i.test(t)) return true;
    if (/\u25CF\s+Running\b/.test(t)) return true;
    if (/\+\d+\s+more tool calls\b/i.test(t)) return true;
    if (/(?:^|[\s])Agent\s+[A-Z]/.test(t)) return true;
    if (/\.{2,}\s*\(\s*\d+\s*s\b/.test(t)) return true;
    if (/\(\s*\d+\s*s\s*[·•]/.test(t)) return true;
    if (
      /\b(?:Polishing the algorithms|Resolving dependencies|I'm Feeling Lucky|I'm going the distance|I'm going for speed|Herding (?:the )?cats|Consulting the archives|Feeding the hamsters|Tuning the flux capacitor|Untangling the yarn|Compiling the essence|Finding existential crises|existential crises|Snozberries taste like snozberries|Microchips and salsa|Warming up the dial-up modem|Pre-heating the servers|Charging the laser|Updating the syntax for reality|Almost there|Making it go beep boop|One moment, optimizing humor|Communing with the machine spirit|Garbage collecting|Are you not entertained|Letting the thoughts marinate|Enhancing|It's not a bug, it's a feature)\b/i.test(
        t,
      )
    ) {
      return true;
    }
    if (/^[\u2800-\u28FF]/.test(t)) return true;
    return false;
  }

  private isStandaloneRenderedAssistantLine(text: string): boolean {
    if (!/^\s{4,}\S/.test(text)) {
      return false;
    }

    const trimmed = text.trim();
    if (!trimmed || this.isTuiNoiseLine(trimmed)) {
      return false;
    }

    if (
      /Qwen Code|API Key \||\/model to change|Type your message|Tips: Try \/insight/i.test(trimmed)
    ) {
      return false;
    }

    if (/[▄█]{2,}|██╔|██║|╚████/.test(trimmed)) {
      return false;
    }

    if (
      /^[╭╮╯╰]/.test(trimmed) ||
      /^│\s*[✓✎⊶⧖⚡✗✖✔●]/.test(trimmed) ||
      /^[─━]{5,}$/.test(trimmed)
    ) {
      return false;
    }

    return /^[┌└├│]/.test(trimmed) || /[A-Za-zÀ-ÿ]/.test(trimmed);
  }

  private collectRenderedAssistantBlocks(lines: string[]): string[] {
    const blocks: string[] = [];
    let i = 0;

    const belongsToStarBlock = (index: number): boolean => {
      for (let j = index - 1; j >= Math.max(0, index - 4); j -= 1) {
        const previous = lines[j];
        if (!previous || previous.trim() === "") {
          continue;
        }
        return /^\s{0,4}✦\s+/.test(previous);
      }
      return false;
    };

    while (i < lines.length) {
      const line = lines[i];
      if (!this.isStandaloneRenderedAssistantLine(line) || belongsToStarBlock(i)) {
        i += 1;
        continue;
      }

      const collected: string[] = [];
      while (i < lines.length) {
        const next = lines[i];
        if (!next) {
          break;
        }
        if (next.trim() === "") {
          if (collected.length > 0 && collected.at(-1) !== "") {
            collected.push("");
          }
          i += 1;
          continue;
        }
        if (!this.isStandaloneRenderedAssistantLine(next)) {
          break;
        }
        collected.push(next.replace(/\s+$/g, ""));
        i += 1;
      }

      const text = this.formatAssistantBlock(collected);
      if (
        text.length >= 10 &&
        !this.isTuiNoiseLine(text) &&
        this.isMeaningfulRenderedAssistantBlock(text)
      ) {
        blocks.push(text);
      }
    }

    return blocks;
  }

  private isMeaningfulRenderedAssistantBlock(text: string): boolean {
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return false;
    }

    const structuredLines = lines.filter(
      (line) => /^[|┌└├│]/.test(line) || /[┌┐└┘├┤┬┴┼│─]/.test(line),
    );
    const proseLines = lines.filter(
      (line) =>
        /[A-Za-zÀ-ÿ]/.test(line) &&
        !/^[|┌└├│]/.test(line) &&
        !/^\|?\s*[-:]{3,}\s*\|?/.test(line),
    );

    if (structuredLines.length > 0) {
      return (
        (proseLines.length >= 1 && text.length >= 80) ||
        (structuredLines.length >= 8 && text.length >= 180)
      );
    }

    return lines.length >= 2 && text.length >= 40;
  }

  /**
   * Collect all ✦-prefixed text blocks from screen lines.
   * Each block starts at a ✦ line and continues with indented continuation lines.
   */
  private collectAssistantBlocks(lines: string[], entry: SessionEntry): string[] {
    const blocks: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s{0,4}✦\s+/.test(line)) {
        // Skip Qwen's internal reasoning blocks (✦ printed in muted gray).
        if (entry.screen.isRowReasoning(i)) {
          i += 1;
          while (i < lines.length) {
            const next = lines[i];
            if (!next) break;
            if (next.trim() === "") {
              i += 1;
              continue;
            }
            if (/^\s{0,4}✦\s+/.test(next)) break;
            if (/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(next)) break;
            if (/^[─━]{5,}/.test(next.trim())) break;
            if (/^[╭╮╯╰]/.test(next.trim())) break;
            if (/^\s*>/.test(next)) break;
            if (this.isTuiNoiseLine(next)) break;
            if (/^\s{4}/.test(next)) { i += 1; } else { break; }
          }
          continue;
        }
        const collected: string[] = [];
        const startLine = line.replace(/^\s{0,4}✦\s+/, "").trimEnd();
        if (startLine && !this.isTuiNoiseLine(startLine)) collected.push(startLine);
        i += 1;
        // Continuation lines: 4+ space indented, not a new ✦, not a border/spinner.
        while (i < lines.length) {
          const next = lines[i];
          if (!next) break;
          if (next.trim() === "") {
            if (collected.length > 0 && collected.at(-1) !== "") {
              collected.push("");
            }
            i += 1;
            continue;
          }
          if (/^\s{0,4}✦\s+/.test(next)) break; // next assistant block
          if (/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(next)) break; // spinner
          if (/^[─━]{5,}/.test(next.trim())) break; // separator line
          if (/^[╭╮╯╰]/.test(next.trim())) break; // tool panel border
          if (/^\s*>/.test(next)) break; // input prompt
          if (this.isTuiNoiseLine(next)) break; // Qwen footer / spinner phrase
          // Rows padded with huge cursor jumps (e.g. `\u001b[120C…`) render as
          // a line with 80+ leading spaces before any real character. Those
          // rows never belong to the assistant response.
          if (/^\s{40,}\S/.test(next)) break;
          // Must be indented continuation
          if (/^\s{4}/.test(next)) {
            collected.push(next.replace(/\s+$/g, ""));
            i += 1;
          } else {
            break;
          }
        }
        const text = this.formatAssistantBlock(collected);
        if (text.length >= 10 && !this.isTuiNoiseLine(text)) blocks.push(text);
      } else {
        i += 1;
      }
    }
    return blocks;
  }

  private formatAssistantBlock(lines: string[]): string {
    const trimmedLines = lines.map((line) => line.replace(/\s+$/g, ""));
    while (trimmedLines.length > 0 && trimmedLines[0]?.trim() === "") {
      trimmedLines.shift();
    }
    while (trimmedLines.length > 0 && trimmedLines.at(-1)?.trim() === "") {
      trimmedLines.pop();
    }
    if (trimmedLines.length === 0) {
      return "";
    }

    const nonEmptyLines = trimmedLines.filter((line) => line.trim().length > 0);
    const commonIndent = nonEmptyLines.reduce<number>((smallest, line) => {
      const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
      return Math.min(smallest, indent);
    }, Number.MAX_SAFE_INTEGER);
    const normalizedLines = trimmedLines.map((line) =>
      line.trim().length > 0 ? line.slice(Math.min(commonIndent, line.length)) : "",
    );

    const hasStructuredLayout = normalizedLines.some((line) =>
      /[┌┐└┘├┤┬┴┼│─]/.test(line),
    );
    if (hasStructuredLayout) {
      return normalizedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    const formatted: string[] = [];
    const isListLine = (line: string): boolean =>
      /^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line);
    const isHeadingLike = (line: string): boolean =>
      !isListLine(line) &&
      line.length <= 72 &&
      !/[.!?]$/.test(line) &&
      !/:$/.test(line) &&
      !/[`*_]/.test(line);

    const appendToPrevious = (line: string) => {
      const previous = formatted.pop() ?? "";
      formatted.push(`${previous} ${line}`.replace(/\s{2,}/g, " ").trim());
    };

    for (const line of normalizedLines) {
      if (!line.trim()) {
        if (formatted.at(-1) !== "") {
          formatted.push("");
        }
        continue;
      }

      const previous = formatted.at(-1) ?? "";
      if (!previous) {
        formatted.push(line.trim());
        continue;
      }

      const previousIsList = isListLine(previous);
      const currentIsList = isListLine(line);
      const currentIsHeading = isHeadingLike(line);

      if (previousIsList && !currentIsList && !currentIsHeading) {
        appendToPrevious(line);
        continue;
      }

      if (
        !previousIsList &&
        !currentIsList &&
        !currentIsHeading &&
        !/[.!?:)]$/.test(previous)
      ) {
        appendToPrevious(line);
        continue;
      }

      if (currentIsHeading && previous !== "") {
        if (formatted.at(-1) !== "") {
          formatted.push("");
        }
        formatted.push(line.trim());
        continue;
      }

      formatted.push(line.trim());
    }

    return formatted.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  private stripAnsi(value: string): string {
    return value
      .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
      .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r(?!\n)/g, "\n")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replace(/\u001b/g, "");
  }

  private ensureTrace(entry: SessionEntry): void {
    if (entry.ptyTraceStream && entry.ptyTracePath) {
      return;
    }
    const logsDir = path.join(homedir(), ".openremote", "pty-logs");
    mkdirSync(logsDir, { recursive: true });
    const tracePath = path.join(logsDir, `${entry.id}-${Date.now()}-qwen.jsonl`);
    entry.ptyTracePath = tracePath;
    entry.ptyTraceStream = createWriteStream(tracePath, { flags: "a" });
    this.writeTrace(entry, "trace-start", {
      sessionId: entry.id,
      projectPath: entry.projectPath,
      provider: "qwen",
      tracePath,
    });
    this.emit("sessionLog", entry.id, tracePath);
    log.debug(`${ts()} session ${entry.id} - PTY trace ${tracePath}`);
  }

  private writeTrace(entry: SessionEntry, event: string, payload: Record<string, unknown>): void {
    if (!entry.ptyTraceStream) {
      return;
    }
    entry.ptyTraceStream.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...payload,
      })}\n`,
    );
  }

  private closeTrace(entry: SessionEntry): void {
    if (!entry.ptyTraceStream) {
      return;
    }
    this.writeTrace(entry, "trace-end", { sessionId: entry.id, status: entry.status });
    entry.ptyTraceStream.end();
    entry.ptyTraceStream = null;
  }
}
