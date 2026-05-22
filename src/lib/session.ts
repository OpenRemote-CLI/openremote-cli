import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";
import { Bridge } from "./bridge.js";
import { ClaudeRunner } from "./claude-runner.js";
import { CodexRunner } from "./codex-runner.js";
import type { ProviderRunner } from "./provider-runner.js";
import { resolveExistingProjectPath } from "./project-path.js";
import { QwenRunner } from "./qwen-runner.js";
import type { AgentProvider, AppConfig, AttachmentRef, InboundMessage, SessionStatus } from "./types.js";
import type { DashboardState } from "./terminal-ui.js";

function providerLabel(provider: AgentProvider): string {
  if (provider === "qwen") return "Qwen";
  if (provider === "claude") return "Claude";
  return "Codex";
}

/**
 * Manages a single provider session at a time.
 * Receives commands from the bridge, delegates to the matching runner,
 * and streams results back through the bridge.
 */
export class SessionManager {
  private readonly runners: Partial<Record<AgentProvider, ProviderRunner>>;
  private readonly sessionProviders = new Map<string, AgentProvider>();
  private readonly sessionStatuses = new Map<string, SessionStatus>();
  private readonly sessionLogs = new Map<string, string>();

  constructor(
    private readonly bridge: Bridge,
    private readonly apiKey: string,
    supportedProviders: AgentProvider[],
    private readonly config?: AppConfig,
  ) {
    this.runners = {
      ...(supportedProviders.includes("codex") ? { codex: new CodexRunner() } : {}),
      ...(supportedProviders.includes("qwen") ? { qwen: new QwenRunner() } : {}),
      ...(supportedProviders.includes("claude") ? { claude: new ClaudeRunner() } : {}),
    };
    this.wireRunnerEvents();
  }

  /**
   * Download attachments from signed URLs to a local temp directory.
   * Returns an array of local file paths.
   */
  private async downloadAttachments(
    sessionId: string,
    refs: AttachmentRef[],
  ): Promise<string[]> {
    if (refs.length === 0) return [];

    const localDir = join(tmpdir(), "openremote-attachments", sessionId);
    mkdirSync(localDir, { recursive: true });

    const localPaths: string[] = [];

    for (const ref of refs) {
      const localPath = join(localDir, ref.name);

      try {
        const resp = await fetch(ref.url);

        if (!resp.ok) {
          log.debug(`Failed to download attachment ${ref.name}: ${resp.status}`);
          continue;
        }

        const buffer = Buffer.from(await resp.arrayBuffer());
        writeFileSync(localPath, buffer);
        localPaths.push(localPath);
        log.debug(`Downloaded attachment to ${localPath} (${buffer.length} bytes)`);
      } catch (err) {
        log.debug(`Error downloading attachment ${ref.name}: ${err}`);
      }
    }

    return localPaths;
  }

  handleMessage(msg: InboundMessage): void {
    switch (msg.type) {
      case "session:start":
        void this.handleStart(msg.payload);
        break;
      case "session:cancel":
        this.handleCancel(msg.payload.sessionId);
        break;
      case "session:respond":
        this.handleRespond(
          msg.payload.sessionId,
          msg.payload.requestId,
          msg.payload.optionIndex,
        );
        break;
      case "session:input":
        void this.handleInput(msg.payload);
        break;
      case "session:finish":
        this.handleFinish(msg.payload.sessionId);
        break;
      default:
        break;
    }
  }

  shutdown(): void {
    for (const runner of Object.values(this.runners)) {
      runner?.killAll();
    }
    this.sessionProviders.clear();
    this.sessionStatuses.clear();
  }

  get busy(): boolean {
    return this.hasBusySessions();
  }

  private getActiveSessionCount(): number {
    let count = 0;
    for (const status of this.sessionStatuses.values()) {
      if (status === "queued" || status === "running") {
        count += 1;
      }
    }
    return count;
  }

  private updateActiveSessionCount(): void {
    log.setDashboard({
      activeSessions: this.getActiveSessionCount(),
    });
  }

  private async handleStart(payload: {
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
  }): Promise<void> {
    const runner = this.getRunner(payload.provider);
    if (!runner) {
      this.failUnsupportedProvider(payload.sessionId, payload.provider);
      return;
    }

    // Normalize copy/paste artifacts before checking the local filesystem.
    const projectPath = resolveExistingProjectPath(payload.projectPath);

    if (!projectPath.ok) {
      // Log the raw bytes to help diagnose invisible characters when the
      // error keeps reproducing on a path that "looks" correct.
      const codes = Array.from(projectPath.input).map((c) => c.charCodeAt(0));
      log.card(
        "Invalid project path",
        [projectPath.input, `chars: ${codes.join(",")}`],
        "danger",
      );
      this.bridge.send({
        type: "session:error",
        payload: {
          sessionId: payload.sessionId,
          error: `Project path does not exist: ${projectPath.input}`,
        },
      });
      this.bridge.send({
        type: "session:status",
        payload: {
          sessionId: payload.sessionId,
          status: "failed",
        },
      });
      return;
    }

    if (projectPath.path !== payload.projectPath.trim()) {
      log.debug(`Normalized project path: ${payload.projectPath} -> ${projectPath.path}`);
    }
    payload.projectPath = projectPath.path;

    // Download attachments from Supabase Storage if present
    let localAttachments: string[] | undefined;
    if (payload.attachments && payload.attachments.length > 0) {
      localAttachments = await this.downloadAttachments(payload.sessionId, payload.attachments);
    }

    log.step("Starting a new session");
    log.setDashboard({
      activeSessions: this.getActiveSessionCount() + 1,
      sessionId: `${payload.sessionId.slice(0, 8)}...`,
      sessionState: "queued",
      sessionDetail: "Preparing the remote session",
      providerName: providerLabel(payload.provider),
      modelName: payload.modelName,
      reasoning: payload.reasoningEffort,
      approvalMode: payload.approvalMode,
    });
    log.clearInfoBar();

    this.sessionProviders.set(payload.sessionId, payload.provider);
    this.sessionStatuses.set(payload.sessionId, "queued");
    this.bridge.registerSessionProvider(payload.sessionId, payload.provider);
    this.updateActiveSessionCount();
    runner.startSession({
      sessionId: payload.sessionId,
      projectPath: payload.projectPath,
      prompt: payload.prompt,
      modelName: payload.modelName,
      reasoningEffort: payload.reasoningEffort,
      approvalMode: payload.approvalMode,
      planMode: payload.planMode,
      apiKey: payload.provider === "codex" ? this.apiKey : undefined,
      providerSessionId: payload.provider === "qwen" ? payload.sessionId : null,
      attachments: localAttachments,
    });
  }

  private handleCancel(sessionId: string): void {
    const runner = this.getRunnerForSession(sessionId);
    if (!runner) return;
    log.step("Cancelling the current session");
    runner.cancelSession(sessionId);
  }

  private handleRespond(
    sessionId: string,
    requestId: string,
    optionIndex: number,
  ): void {
    const runner = this.getRunnerForSession(sessionId);
    log.debug(
      `[RESPOND] Received: sessionId=${sessionId}, requestId=${requestId}, optionIndex=${optionIndex}`,
    );
    if (!runner) {
      log.debug("[RESPOND] Ignoring - missing runner for session");
      this.bridge.send({
        type: "session:error",
        payload: {
          sessionId,
          error: "Approval could not be resolved because the session is no longer active.",
        },
      });
      return;
    }
    log.debug("[RESPOND] Calling runner.respondToSession()");
    const result = runner.respondToSession(sessionId, requestId, optionIndex);
    if (!result.ok) {
      this.bridge.send({
        type: "session:error",
        payload: {
          sessionId,
          error:
            result.error ??
            "Approval could not be resolved because it is no longer pending.",
        },
      });
    }
  }

  private async handleInput(payload: {
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
  }): Promise<void> {
    const provider = payload.provider ?? this.sessionProviders.get(payload.sessionId) ?? null;
    if (!provider) {
      log.card(
        "Missing session provider",
        ["Open the session again after the app refreshes its data."],
        "warning",
      );
      this.bridge.send({
        type: "session:error",
        payload: {
          sessionId: payload.sessionId,
          error: "Session provider missing for resume",
        },
      });
      return;
    }

    const runner = this.getRunner(provider);
    if (!runner) {
      this.failUnsupportedProvider(payload.sessionId, provider);
      return;
    }

    // Download attachments from Supabase Storage if present
    let localAttachments: string[] | undefined;
    if (payload.attachments && payload.attachments.length > 0) {
      localAttachments = await this.downloadAttachments(payload.sessionId, payload.attachments);
    }

    if (!this.sessionProviders.has(payload.sessionId)) {
      if (!payload.projectPath || !payload.approvalMode) {
        log.card(
          "Missing session metadata",
          ["Open the session again after the app refreshes its data."],
          "warning",
        );
        this.bridge.send({
          type: "session:error",
          payload: {
            sessionId: payload.sessionId,
            error: "Session metadata missing for resume",
          },
        });
        return;
      }

      const projectPath = resolveExistingProjectPath(payload.projectPath);
      if (!projectPath.ok) {
        this.bridge.send({
          type: "session:error",
          payload: {
            sessionId: payload.sessionId,
            error: `Project path does not exist: ${projectPath.input}`,
          },
        });
        this.bridge.send({
          type: "session:status",
          payload: {
            sessionId: payload.sessionId,
            status: "failed",
          },
        });
        return;
      }

      if (projectPath.path !== payload.projectPath.trim()) {
        log.debug(`Normalized resume project path: ${payload.projectPath} -> ${projectPath.path}`);
      }

      log.step("Resuming the selected session");
      log.setDashboard({
        sessionId: `${payload.sessionId.slice(0, 8)}...`,
        sessionState: "resuming",
        sessionDetail: "Reopening the selected conversation",
        providerName: providerLabel(provider),
        modelName: payload.modelName ?? (provider === "qwen" ? "qwen-default" : provider === "claude" ? "claude-sonnet-4-6" : "gpt-5.4"),
        reasoning: payload.reasoningEffort ?? "medium",
        approvalMode: payload.approvalMode,
      });
      log.clearInfoBar();

      this.sessionProviders.set(payload.sessionId, provider);
      this.sessionStatuses.set(payload.sessionId, "queued");
      this.bridge.registerSessionProvider(payload.sessionId, provider);
      runner.resumeSession({
        sessionId: payload.sessionId,
        projectPath: projectPath.path,
        prompt: payload.text,
        modelName: payload.modelName ?? (provider === "qwen" ? "qwen-default" : provider === "claude" ? "claude-sonnet-4-6" : "gpt-5.4"),
        reasoningEffort: payload.reasoningEffort ?? "medium",
        approvalMode: payload.approvalMode,
        planMode: provider === "qwen" ? false : (payload.planMode ?? false),
        apiKey: provider === "codex" ? this.apiKey : undefined,
        providerSessionId:
          payload.providerSessionId ?? (provider === "qwen" ? payload.sessionId : null),
        attachments: localAttachments,
      });
      return;
    }

    const { sessionId, text } = payload;
    log.step("Sending your follow-up");
    const followUpDashboard: Partial<DashboardState> = {
      sessionId: `${sessionId.slice(0, 8)}...`,
      sessionState: "running",
      sessionDetail: `Sending a follow-up to ${providerLabel(provider)}`,
      providerName: providerLabel(provider),
    };
    if (payload.modelName) {
      followUpDashboard.modelName = payload.modelName;
    }
    if (payload.reasoningEffort) {
      followUpDashboard.reasoning = payload.reasoningEffort;
    }
    log.setDashboard(followUpDashboard);
    log.clearInfoBar();
    runner.inputToSession(
      sessionId,
      text,
      payload.modelName,
      provider === "qwen" ? false : payload.planMode,
      payload.reasoningEffort,
      payload.approvalMode,
      localAttachments,
    );
  }

  private handleFinish(sessionId: string): void {
    if (!this.sessionProviders.has(sessionId)) return;
    log.step("Finishing the current session");
    this.finishProviderSession(sessionId);
  }

  private wireRunnerEvents(): void {
    for (const [provider, runner] of Object.entries(this.runners) as Array<
      [AgentProvider, ProviderRunner | undefined]
    >) {
      if (!runner) {
        continue;
      }

      runner.on("output", (sid, data) => {
        if (provider === "claude") {
          return;
        }
        this.bridge.send({
          type: "session:output",
          payload: { sessionId: sid, data, timestamp: Date.now() },
        });
      });

      runner.on("readableBlock", (sid, block) => {
        this.bridge.send({
          type: "session:block",
          payload: { sessionId: sid, block },
        });
      });

      runner.on("status", (sid, status) => {
        this.sessionStatuses.set(sid, status);
        this.updateActiveSessionCount();
        if (status === "running") {
          log.setDashboard({
            sessionId: `${sid.slice(0, 8)}...`,
            sessionState: "running",
            sessionDetail: `${providerLabel(provider)} is working on your request`,
            providerName: providerLabel(provider),
          });
          log.clearInfoBar();
          log.step("Session running");
        } else if (status === "idle") {
          log.setDashboard({
            sessionId: `${sid.slice(0, 8)}...`,
            sessionState: "idle",
            sessionDetail: "Waiting for a follow-up",
            providerName: providerLabel(provider),
          });
          log.clearInfoBar();
          log.ok("Session completed");
          log.step("Waiting for the next prompt");
        } else if (status === "queued") {
          log.setDashboard({
            sessionId: `${sid.slice(0, 8)}...`,
            sessionState: "queued",
            sessionDetail: "Preparing the session",
            providerName: providerLabel(provider),
          });
          log.clearInfoBar();
          log.step("Preparing the session");
        } else if (status === "cancelled") {
          log.setDashboard({
            sessionId: "-",
            sessionState: "idle",
            sessionDetail: "Waiting for a remote session",
            providerName: "-",
          });
          log.clearInfoBar();
          log.ok("Session cancelled");
        } else if (status === "completed") {
          log.setDashboard({
            sessionId: "-",
            sessionState: "idle",
            sessionDetail: "Waiting for a remote session",
            providerName: "-",
          });
          log.clearInfoBar();
          log.ok("Session closed");
        } else if (status === "failed") {
          log.setDashboard({
            sessionId: `${sid.slice(0, 8)}...`,
            sessionState: "failed",
            sessionDetail: "The session failed",
            providerName: providerLabel(provider),
          });
          log.infoBar("Session failed. Review the error below.", "danger");
          log.error("Session failed");
        } else {
          log.debug(`Session ${sid} status -> ${status}`);
        }
        this.bridge.send({
          type: "session:status",
          payload: { sessionId: sid, status },
        });
      });

      runner.on("approval", (sid, requestId, title, message, options, kind) => {
        log.setDashboard({
          sessionId: `${sid.slice(0, 8)}...`,
          sessionState: "approval",
          sessionDetail: "Waiting for approval",
          providerName: providerLabel(provider),
        });
        this.bridge.send({
          type: "session:approval",
          payload: {
            sessionId: sid,
            requestId,
            title: title ?? undefined,
            provider,
            message,
            kind: kind ?? "permission",
            options: options.map((option) => ({
              label: option.label,
              index: option.index,
              ...(option.description ? { description: option.description } : {}),
            })),
          },
        });
      });

      runner.on("complete", (sid, exitCode, duration) => {
        const sec = (duration / 1000).toFixed(1);
        const tracePath = this.sessionLogs.get(sid);
        log.setDashboard({
          sessionId: "-",
          sessionState: "idle",
          sessionDetail: "Waiting for a remote session",
          providerName: "-",
        });
        log.clearInfoBar();
        log.summary("Session finished", [
          ["Session", `${sid.slice(0, 8)}...`],
          ["Provider", providerLabel(provider)],
          ["Exit code", String(exitCode)],
          ["Duration", `${sec}s`],
          ...(tracePath ? ([["Log file", tracePath]] as Array<[string, string]>) : []),
        ]);
        if (tracePath) {
          log.note(`Session log: ${tracePath}`, "info");
        }
        this.bridge.send({
          type: "session:complete",
          payload: { sessionId: sid, exitCode, duration },
        });

        this.sessionStatuses.delete(sid);
        this.sessionProviders.delete(sid);
        this.sessionLogs.delete(sid);
        this.updateActiveSessionCount();
        log.step("Waiting for a session");
      });

      runner.on("error", (sid, error) => {
        log.setDashboard({
          sessionId: `${sid.slice(0, 8)}...`,
          sessionState: "failed",
          sessionDetail: "The session failed",
          providerName: providerLabel(provider),
        });
        log.infoBar("Session failed. Review the error below.", "danger");
        log.card("Session error", [error], "danger");
        this.bridge.send({
          type: "session:error",
          payload: { sessionId: sid, error },
        });
      });

      runner.on("providerSession", (sid, providerSessionId) => {
        log.debug(
          `Session ${sid.slice(0, 8)}... ${provider} session -> ${providerSessionId}`,
        );
        this.bridge.send({
          type: "session:meta",
          payload: { sessionId: sid, providerSessionId },
        });
      });

      runner.on("sessionLog", (sid, tracePath) => {
        this.sessionLogs.set(sid, tracePath);
        log.debug(`Session ${sid.slice(0, 8)}... log -> ${tracePath}`);
      });
    }
  }

  private getRunner(provider: AgentProvider): ProviderRunner | null {
    return this.runners[provider] ?? null;
  }

  private getRunnerForSession(sessionId: string): ProviderRunner | null {
    const provider = this.sessionProviders.get(sessionId);
    if (!provider) {
      return null;
    }
    return this.getRunner(provider);
  }

  private finishProviderSession(sessionId: string): void {
    const runner = this.getRunnerForSession(sessionId);
    runner?.finishSession(sessionId);
  }

  private hasBusySessions(): boolean {
    for (const status of this.sessionStatuses.values()) {
      if (status === "queued" || status === "running") {
        return true;
      }
    }
    return false;
  }

  private failUnsupportedProvider(sessionId: string, provider: AgentProvider): void {
    const label = providerLabel(provider);
    log.card(
      `${label} CLI not found`,
      [`Install it before starting a ${label} session.`],
      "danger",
    );
    this.bridge.send({
      type: "session:error",
      payload: {
        sessionId,
        error: `${label} CLI is not available on this machine`,
      },
    });
    this.bridge.send({
      type: "session:status",
      payload: {
        sessionId,
        status: "failed",
      },
    });
  }
}
