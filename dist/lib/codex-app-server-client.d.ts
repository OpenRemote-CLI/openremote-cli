import { EventEmitter } from "node:events";
type JsonRpcId = string | number;
interface CodexAppServerClientEvents {
    notification: (method: string, params: Record<string, unknown> | undefined) => void;
    serverRequest: (id: JsonRpcId, method: string, params: Record<string, unknown> | undefined) => void;
    closed: (reason: string) => void;
    trace: (event: string, payload: Record<string, unknown>) => void;
}
export declare class CodexAppServerClient extends EventEmitter {
    private process;
    private socket;
    private readyPromise;
    private pending;
    private nextId;
    private initialized;
    private closing;
    private listenUrl;
    private activeApiKey;
    on<K extends keyof CodexAppServerClientEvents>(event: K, fn: CodexAppServerClientEvents[K]): this;
    emit<K extends keyof CodexAppServerClientEvents>(event: K, ...args: Parameters<CodexAppServerClientEvents[K]>): boolean;
    ensureReady(apiKey?: string): Promise<void>;
    request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
    respond(id: JsonRpcId, result: Record<string, unknown>): void;
    respondError(id: JsonRpcId, message: string, code?: number): void;
    stop(): Promise<void>;
    private bootstrap;
    private buildLaunch;
    private reservePort;
    private connectWebSocket;
    private openSocketOnce;
    private attachSocket;
    private handleSocketMessage;
    private sendFrame;
    private handleUnexpectedClose;
}
export {};
