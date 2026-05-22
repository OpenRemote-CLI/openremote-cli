import { EventEmitter } from "node:events";
import {
  type RealtimeChannel,
  type SupabaseClient,
  createClient,
} from "@supabase/supabase-js";
import { log } from "./logger.js";
import {
  deriveReadableBlocksFromChunk,
  makeReadableApprovalBlock,
  makeReadableErrorBlock,
  makeReadableStatusBlock,
} from "./readable-output.js";
import type {
  AgentProvider,
  AppConfig,
  InboundMessage,
  MachineAvailabilityState,
  OutboundMessage,
  SessionIngestEvent,
  SessionIngestOutputSegment,
  SessionReadableBlockIngest,
  SessionPatch,
  SessionStatus,
} from "./types.js";

interface BridgeEvents {
  connected: () => void;
  disconnected: () => void;
  ready: () => void;
  message: (msg: InboundMessage) => void;
}

interface MachineSessionResponse {
  accessToken: string;
  expiresAt: string;
}

interface SessionBuffer {
  text: string;
  byteCount: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastTimestamp: number;
}

interface SessionState {
  provider: AgentProvider | null;
  eventSeq: number;
  outputSeq: number;
  readableRemainder: string;
  lastStatus: SessionStatus | null;
  output: SessionBuffer;
}

const OUTPUT_FLUSH_MS = 250;
const OUTPUT_MAX_BYTES = 8 * 1024;
const HEARTBEAT_MS = 30_000;
const OFFLINE_GRACE_MS = 90_000;

function nowIso(): string {
  return new Date().toISOString();
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sessionTopic(sessionId: string): string {
  return `session:${sessionId}`;
}

function machineTopic(machineId: string): string {
  return `machine:${machineId}`;
}

export class Bridge extends EventEmitter {
  private client: SupabaseClient | null = null;
  private machineChannel: RealtimeChannel | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30_000;
  private shouldReconnect = true;
  private machineAccessToken: string | null = null;
  private machineAccessTokenExpiresAt = 0;
  private machineState: MachineAvailabilityState = "idle";
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly config: AppConfig,
    private readonly machineToken: string,
    private readonly supportedProviders: AgentProvider[],
  ) {
    super();
  }

  override on<K extends keyof BridgeEvents>(event: K, fn: BridgeEvents[K]): this {
    return super.on(event, fn);
  }

  override emit<K extends keyof BridgeEvents>(
    event: K,
    ...args: Parameters<BridgeEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  connect(): void {
    this.shouldReconnect = true;
    void this.openConnection();
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    await this.flushAllOutputs();

    try {
      await this.sendHeartbeat("offline");
    } catch {
      // Ignore disconnect failures.
    }

    if (this.machineChannel && this.client) {
      await this.client.removeChannel(this.machineChannel);
    }

    this.machineChannel = null;
    this.client = null;
    this.machineAccessToken = null;
    this.machineAccessTokenExpiresAt = 0;
  }

  send(msg: OutboundMessage): void {
    void this.handleOutboundMessage(msg).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // Surface at warn level so ingest failures that would otherwise drop
      // readable blocks are visible without --debug. Previously buried at
      // debug, which masked silent block loss on the mobile client.
      log.debug(`Failed to send bridge message (${msg.type}): ${message}`);
      if (msg.type === "session:block" || msg.type === "session:status") {
        log.note(
          `Failed to persist ${msg.type} for session ${"sessionId" in msg.payload ? msg.payload.sessionId.slice(0, 8) : "?"}: ${message}`,
          "warning",
        );
      }
    });
  }

  get isConnected(): boolean {
    return this.machineChannel?.state === "joined";
  }

  registerSessionProvider(sessionId: string, provider: AgentProvider): void {
    this.getSessionState(sessionId).provider = provider;
  }

  private async openConnection(): Promise<void> {
    try {
      const accessToken = await this.ensureMachineAccessToken();
      this.client = createClient(this.config.supabaseUrl, this.config.supabaseAnonKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });

      await this.client.realtime.setAuth(accessToken);

      // Fire the first heartbeat immediately — don't wait for the channel to be
      // SUBSCRIBED. This makes the "machine online" broadcast reach clients as
      // soon as the token is ready, in parallel with the WebSocket handshake.
      void this.sendHeartbeat("idle").catch((err) => {
        log.debug(`Early heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      this.machineChannel = this.client.channel(machineTopic(this.config.machineId), {
        config: {
          private: false,
          broadcast: { ack: true, self: false },
        },
      });

      this.registerInboundEvent("session:start");
      this.registerInboundEvent("session:cancel");
      this.registerInboundEvent("session:respond");
      this.registerInboundEvent("session:input");
      this.registerInboundEvent("session:finish");

      const subscribed = await new Promise<boolean>((resolve) => {
        this.machineChannel!.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            resolve(true);
            return;
          }

          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            resolve(false);
          }
        });
      });

      if (!subscribed) {
        throw new Error("Could not subscribe to machine channel");
      }

      this.reconnectDelay = 1000;
      this.emit("connected");
      this.startHeartbeatLoop();
      this.emit("ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.setDashboard({
        machineStatus: "offline",
        sessionDetail: "Retrying connection",
      });
      log.infoBar("Couldn't connect. Retrying automatically.", "danger");
      log.card("Couldn't connect", [message, "Check your network and retry."], "danger");
      this.scheduleReconnect();
    }
  }

  private registerInboundEvent(event: InboundMessage["type"]): void {
    this.machineChannel?.on("broadcast", { event }, ({ payload }) => {
      this.emit("message", {
        type: event,
        payload: payload as InboundMessage["payload"],
      } as InboundMessage);
    });
  }

  private async handleOutboundMessage(msg: OutboundMessage): Promise<void> {
    if (msg.type === "machine:offline") {
      await this.disconnect();
      return;
    }

    const sessionId = "sessionId" in msg.payload ? msg.payload.sessionId : null;
    if (sessionId && msg.type !== "session:output") {
      await this.flushOutputBuffer(sessionId, true);
    }

    switch (msg.type) {
      case "session:output":
        this.bufferOutput(msg.payload.sessionId, msg.payload.data, msg.payload.timestamp);
        return;

      case "session:block": {
        await this.ingest(msg.payload.sessionId, {
          readableBlocks: [
            {
              ...msg.payload.block,
              occurredAt: msg.payload.block.occurredAt ?? nowIso(),
            },
          ],
        });
        return;
      }

      case "session:status":
        this.getSessionState(msg.payload.sessionId).lastStatus = msg.payload.status;
        this.machineState = this.recomputeMachineState();
        {
          const readableBlock = makeReadableStatusBlock(
            msg.payload.status,
            nowIso(),
          );
          await this.ingest(msg.payload.sessionId, {
            events: [this.makeEvent(msg.type, msg.payload.sessionId, msg.payload)],
            readableBlocks: [readableBlock],
            sessionPatch: { status: msg.payload.status },
            machineState: this.machineState,
          });
        }
        return;

      case "session:approval":
        {
          const readableBlock = makeReadableApprovalBlock(
            msg.payload.message,
            nowIso(),
          );
          await this.ingest(msg.payload.sessionId, {
            events: [this.makeEvent(msg.type, msg.payload.sessionId, msg.payload)],
            readableBlocks: [readableBlock],
          });
        }
        return;

      case "session:error":
        {
          const readableBlock = makeReadableErrorBlock(
            msg.payload.error,
            nowIso(),
          );
          await this.ingest(msg.payload.sessionId, {
            events: [this.makeEvent(msg.type, msg.payload.sessionId, msg.payload)],
            readableBlocks: [readableBlock],
          });
        }
        return;

      case "session:busy":
        {
          const state = this.getSessionState(msg.payload.sessionId);
          state.lastStatus = "running";
          this.machineState = this.recomputeMachineState();
          const occurredAt = nowIso();
          await this.ingest(msg.payload.sessionId, {
            events: [this.makeEvent(msg.type, msg.payload.sessionId, msg.payload)],
            sessionPatch: {
              status: "running",
            },
            machineState: this.machineState,
          });
        }
        return;

      case "session:meta":
        await this.ingest(msg.payload.sessionId, {
          sessionPatch: {
            providerSessionId: msg.payload.providerSessionId,
          },
        });
        return;

      case "session:complete": {
        const state = this.getSessionState(msg.payload.sessionId);
        const finalStatus = state.lastStatus ?? (msg.payload.exitCode === 0 ? "completed" : "failed");
        state.lastStatus = finalStatus;
        this.machineState = this.recomputeMachineState();
        const occurredAt = nowIso();
        const readableBlock = makeReadableStatusBlock(
          finalStatus,
          occurredAt,
          `exit=${msg.payload.exitCode}, duration=${msg.payload.duration}ms`,
        );
        await this.ingest(msg.payload.sessionId, {
          events: [this.makeEvent(msg.type, msg.payload.sessionId, msg.payload)],
          readableBlocks: [readableBlock],
          sessionPatch: {
            status: finalStatus,
            exitCode: msg.payload.exitCode,
            durationMs: msg.payload.duration,
            completedAt: occurredAt,
          },
          machineState: this.machineState,
        });
        this.sessions.delete(msg.payload.sessionId);
        this.machineState = this.recomputeMachineState();
        return;
      }

      default:
        return;
    }
  }

  private getSessionState(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const created: SessionState = {
      provider: null,
      eventSeq: 1,
      outputSeq: 1,
      readableRemainder: "",
      lastStatus: null,
      output: {
        text: "",
        byteCount: 0,
        timer: null,
        lastTimestamp: Date.now(),
      },
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private bufferOutput(sessionId: string, chunk: string, timestamp: number): void {
    const state = this.getSessionState(sessionId);
    state.output.text += chunk;
    state.output.byteCount += Buffer.byteLength(chunk, "utf-8");
    state.output.lastTimestamp = timestamp;

    if (state.output.byteCount >= OUTPUT_MAX_BYTES) {
      void this.flushOutputBuffer(sessionId).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log.debug(`Failed to flush output buffer: ${message}`);
      });
      return;
    }

    if (!state.output.timer) {
      state.output.timer = setTimeout(() => {
        void this.flushOutputBuffer(sessionId).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          log.debug(`Failed to flush output buffer: ${message}`);
        });
      }, OUTPUT_FLUSH_MS);
    }
  }

  private async flushOutputBuffer(sessionId: string, final = false): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (!state.output.text && (!final || !state.readableRemainder)) return;

    if (state.output.timer) {
      clearTimeout(state.output.timer);
      state.output.timer = null;
    }

    const occurredAt = new Date(state.output.lastTimestamp || Date.now()).toISOString();
    const outputText = state.output.text;
    const outputByteCount = state.output.byteCount;

    state.output.text = "";
    state.output.byteCount = 0;

    const { blocks: readableBlocks, remainder } = deriveReadableBlocksFromChunk(
      `${state.readableRemainder}${outputText}`,
      occurredAt,
      { final },
    );
    // Codex, Claude, and Qwen all emit native readable blocks from their
    // runners. Only derive blocks from raw terminal output when the provider is
    // unknown so legacy sessions still have a fallback transcript.
    const shouldDeriveReadableBlocks = state.provider == null;
    state.readableRemainder = shouldDeriveReadableBlocks ? remainder : "";

    const outputSegments: SessionIngestOutputSegment[] =
      outputText.length > 0
        ? [
            {
              seq: state.outputSeq++,
              text: outputText,
              byteCount: outputByteCount,
              occurredAt,
            },
          ]
        : [];

    await this.ingest(sessionId, {
      outputSegments,
      readableBlocks: shouldDeriveReadableBlocks ? readableBlocks : [],
    });
  }

  private async flushAllOutputs(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.flushOutputBuffer(sessionId, true);
    }
  }

  private makeEvent(
    eventType: string,
    sessionId: string,
    payload: Record<string, unknown>,
  ): SessionIngestEvent {
    const state = this.getSessionState(sessionId);
    return {
      seq: state.eventSeq++,
      eventType,
      payload,
      occurredAt: nowIso(),
    };
  }

  private recomputeMachineState(): MachineAvailabilityState {
    for (const state of this.sessions.values()) {
      if (
        state.lastStatus === "queued" ||
        state.lastStatus === "running"
      ) {
        return "busy";
      }
    }
    return "idle";
  }

  private async ingest(
    sessionId: string,
    payload: {
      events?: SessionIngestEvent[];
      outputSegments?: SessionIngestOutputSegment[];
      readableBlocks?: SessionReadableBlockIngest[];
      sessionPatch?: SessionPatch;
      machineState?: MachineAvailabilityState;
    },
  ): Promise<void> {
    const accessToken = await this.ensureMachineAccessToken();
    const body = JSON.stringify({
      sessionId,
      events: payload.events ?? [],
      outputSegments: payload.outputSegments ?? [],
      readableBlocks: payload.readableBlocks ?? [],
      sessionPatch: payload.sessionPatch,
      machineState: payload.machineState,
    });

    const response = await fetch(`${this.config.supabaseUrl}/functions/v1/session-ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        apikey: this.config.supabaseAnonKey,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`session-ingest failed (${response.status}): ${text}`);
    }
  }

  private async sendHeartbeat(state?: MachineAvailabilityState): Promise<void> {
    const accessToken = await this.ensureMachineAccessToken();
    const response = await fetch(`${this.config.supabaseUrl}/functions/v1/machine-heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        apikey: this.config.supabaseAnonKey,
      },
      body: JSON.stringify({
        availabilityState: state ?? this.machineState,
        heartbeatGraceMs: OFFLINE_GRACE_MS,
        cliVersion: this.config.cliVersion,
        supportedProviders: this.supportedProviders,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`machine-heartbeat failed (${response.status}): ${text}`);
    }
  }

  private startHeartbeatLoop(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log.debug(`Heartbeat failed: ${message}`);
        this.handleDisconnect();
      });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async ensureMachineAccessToken(): Promise<string> {
    const refreshBeforeMs = 60_000;
    if (
      this.machineAccessToken &&
      Date.now() + refreshBeforeMs < this.machineAccessTokenExpiresAt
    ) {
      return this.machineAccessToken;
    }

    // Try to use the machine token (stored auth token) to get a session
    const response = await fetch(`${this.config.supabaseUrl}/functions/v1/machine-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.machineToken}`,
        apikey: this.config.supabaseAnonKey,
      },
      body: JSON.stringify({
        machineId: this.config.machineId,
        cliVersion: this.config.cliVersion,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`machine-session failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as MachineSessionResponse;
    this.machineAccessToken = data.accessToken;
    this.machineAccessTokenExpiresAt = new Date(data.expiresAt).getTime();
    if (this.client) {
      await this.client.realtime.setAuth(this.machineAccessToken);
    }
    return this.machineAccessToken;
  }

  private handleDisconnect(): void {
    if (!this.shouldReconnect) return;

    this.stopHeartbeat();
    this.emit("disconnected");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.machineChannel && this.client) {
        await this.client.removeChannel(this.machineChannel);
      }
      this.machineChannel = null;
      this.client = null;
      this.machineAccessToken = null;
      this.machineAccessTokenExpiresAt = 0;
      await nextTick();
      void this.openConnection();
    }, this.reconnectDelay);

    log.status(`Reconnecting in ${(this.reconnectDelay / 1000).toFixed(0)}s`, "warning");
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
