import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import WebSocket from "ws";
import { buildShellCommand, getShellLaunch, resolveExecutable } from "./shell.js";
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function stringifyError(error) {
    return error instanceof Error ? error.message : String(error);
}
export class CodexAppServerClient extends EventEmitter {
    process = null;
    socket = null;
    readyPromise = null;
    pending = new Map();
    nextId = 1;
    initialized = false;
    closing = false;
    listenUrl = null;
    activeApiKey = null;
    on(event, fn) {
        return super.on(event, fn);
    }
    emit(event, ...args) {
        return super.emit(event, ...args);
    }
    async ensureReady(apiKey) {
        if (this.socket &&
            this.socket.readyState === WebSocket.OPEN &&
            this.initialized &&
            (this.activeApiKey === (apiKey ?? null) || !apiKey)) {
            return;
        }
        if (this.readyPromise) {
            await this.readyPromise;
            return;
        }
        if (this.process && apiKey && this.activeApiKey && this.activeApiKey !== apiKey) {
            await this.stop();
        }
        this.readyPromise = this.bootstrap(apiKey ?? null);
        try {
            await this.readyPromise;
        }
        finally {
            this.readyPromise = null;
        }
    }
    async request(method, params) {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error("Codex app-server is not connected.");
        }
        const id = this.nextId++;
        const payload = params === undefined
            ? { jsonrpc: "2.0", id, method }
            : { jsonrpc: "2.0", id, method, params };
        this.emit("trace", "jsonrpc-send", { id, method, params: params ?? null });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out waiting for Codex app-server response to ${method}.`));
            }, 60_000);
            this.pending.set(id, {
                timeout,
                resolve: (value) => resolve(value),
                reject,
            });
            try {
                socket.send(JSON.stringify(payload));
            }
            catch (error) {
                clearTimeout(timeout);
                this.pending.delete(id);
                reject(new Error(`Failed to send Codex app-server request ${method}: ${stringifyError(error)}`));
            }
        });
    }
    respond(id, result) {
        this.sendFrame({ jsonrpc: "2.0", id, result }, "jsonrpc-response");
    }
    respondError(id, message, code = -32000) {
        this.sendFrame({
            jsonrpc: "2.0",
            id,
            error: { code, message },
        }, "jsonrpc-response-error");
    }
    async stop() {
        this.closing = true;
        this.initialized = false;
        this.activeApiKey = null;
        this.listenUrl = null;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("Codex app-server stopped before the request completed."));
        }
        this.pending.clear();
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            try {
                socket.removeAllListeners();
                socket.close();
            }
            catch {
                // Ignore close failures during shutdown.
            }
        }
        const processRef = this.process;
        this.process = null;
        if (processRef && processRef.exitCode === null && !processRef.killed) {
            try {
                processRef.kill();
            }
            catch {
                // Ignore child shutdown failures during cleanup.
            }
        }
        this.closing = false;
    }
    async bootstrap(apiKey) {
        const listenPort = await this.reservePort();
        const listenUrl = `ws://127.0.0.1:${listenPort}`;
        const { command, args, resolvedExecutable } = this.buildLaunch(listenUrl);
        this.emit("trace", "app-server-launch", {
            listenUrl,
            command,
            args,
            resolvedExecutable,
        });
        const env = { ...process.env };
        if (apiKey) {
            env.OPENAI_API_KEY = apiKey;
        }
        const child = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env,
        });
        this.process = child;
        this.listenUrl = listenUrl;
        this.activeApiKey = apiKey;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (data) => {
            this.emit("trace", "app-server-stdout", { data });
        });
        child.stderr.on("data", (data) => {
            this.emit("trace", "app-server-stderr", { data });
        });
        child.on("error", (error) => {
            this.emit("trace", "app-server-process-error", { message: stringifyError(error) });
            this.handleUnexpectedClose(`Codex app-server process error: ${stringifyError(error)}`);
        });
        child.on("exit", (code, signal) => {
            this.emit("trace", "app-server-exit", { code, signal });
            this.handleUnexpectedClose(`Codex app-server exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`);
        });
        const socket = await this.connectWebSocket(listenUrl, child);
        this.socket = socket;
        this.attachSocket(socket);
        await this.request("initialize", {
            clientInfo: {
                name: "openremote",
                title: "OpenRemote",
                version: "1.0.0",
            },
            capabilities: {
                experimentalApi: true,
            },
        });
        this.initialized = true;
        this.emit("trace", "app-server-ready", { listenUrl });
    }
    buildLaunch(listenUrl) {
        const codexArgs = ["app-server", "--listen", listenUrl];
        if (process.platform === "win32") {
            return {
                command: "cmd.exe",
                args: ["/c", "codex", ...codexArgs],
                resolvedExecutable: null,
            };
        }
        const resolvedExecutable = resolveExecutable("codex");
        if (!resolvedExecutable) {
            throw new Error("The codex executable could not be found in the login shell PATH.");
        }
        const shell = getShellLaunch();
        return {
            command: shell.shell,
            args: shell.argsForCommand(`exec ${buildShellCommand("codex", codexArgs)}`),
            resolvedExecutable,
        };
    }
    async reservePort() {
        return await new Promise((resolve, reject) => {
            const server = createServer();
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                    server.close();
                    reject(new Error("Failed to reserve a loopback port for Codex app-server."));
                    return;
                }
                const { port } = address;
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(port);
                });
            });
        });
    }
    async connectWebSocket(listenUrl, child) {
        const deadline = Date.now() + 15_000;
        let lastError = null;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) {
                throw new Error(`Codex app-server exited before opening ${listenUrl}.`);
            }
            try {
                const socket = await this.openSocketOnce(listenUrl);
                this.emit("trace", "app-server-connected", { listenUrl });
                return socket;
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                await delay(250);
            }
        }
        throw new Error(`Timed out connecting to Codex app-server at ${listenUrl}${lastError ? `: ${lastError.message}` : "."}`);
    }
    async openSocketOnce(listenUrl) {
        return await new Promise((resolve, reject) => {
            const socket = new WebSocket(listenUrl, { handshakeTimeout: 2_000 });
            const cleanup = () => {
                socket.removeAllListeners("open");
                socket.removeAllListeners("error");
                socket.removeAllListeners("unexpected-response");
            };
            socket.once("open", () => {
                cleanup();
                resolve(socket);
            });
            socket.once("error", (error) => {
                cleanup();
                reject(error);
            });
            socket.once("unexpected-response", (_req, response) => {
                cleanup();
                reject(new Error(`Unexpected WebSocket response (${response.statusCode ?? "unknown"}).`));
            });
        });
    }
    attachSocket(socket) {
        socket.on("message", (data) => {
            void this.handleSocketMessage(data);
        });
        socket.on("error", (error) => {
            this.emit("trace", "app-server-socket-error", { message: stringifyError(error) });
        });
        socket.on("close", (code, reason) => {
            const message = `Codex app-server socket closed (${code})${reason.length > 0 ? `: ${reason.toString()}` : ""}`;
            this.emit("trace", "app-server-socket-close", { code, reason: reason.toString() });
            this.handleUnexpectedClose(message);
        });
    }
    async handleSocketMessage(data) {
        const text = typeof data === "string"
            ? data
            : Buffer.isBuffer(data)
                ? data.toString("utf8")
                : Buffer.from(data).toString("utf8");
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch (error) {
            this.emit("trace", "jsonrpc-invalid-message", {
                data: text,
                error: stringifyError(error),
            });
            return;
        }
        if ("method" in parsed && typeof parsed.method === "string") {
            if ("id" in parsed) {
                this.emit("trace", "jsonrpc-server-request", {
                    id: parsed.id,
                    method: parsed.method,
                });
                this.emit("serverRequest", parsed.id, parsed.method, parsed.params ?? undefined);
                return;
            }
            this.emit("trace", "jsonrpc-notification", { method: parsed.method });
            this.emit("notification", parsed.method, parsed.params ?? undefined);
            return;
        }
        if (!("id" in parsed)) {
            this.emit("trace", "jsonrpc-unknown-frame", { frame: parsed });
            return;
        }
        const id = parsed.id;
        const pending = this.pending.get(id);
        if (!pending) {
            this.emit("trace", "jsonrpc-unmatched-response", { id, frame: parsed });
            return;
        }
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        if ("error" in parsed && parsed.error) {
            const errorPayload = parsed.error;
            const message = errorPayload?.message || `Codex app-server request ${String(id)} failed.`;
            this.emit("trace", "jsonrpc-response-error", { id, message });
            pending.reject(new Error(message));
            return;
        }
        this.emit("trace", "jsonrpc-response", { id });
        pending.resolve(parsed.result);
    }
    sendFrame(frame, traceEvent) {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error("Codex app-server is not connected.");
        }
        this.emit("trace", traceEvent, frame);
        socket.send(JSON.stringify(frame));
    }
    handleUnexpectedClose(reason) {
        const hadConnection = Boolean(this.socket || this.process || this.initialized || this.pending.size);
        this.initialized = false;
        this.listenUrl = null;
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            socket.removeAllListeners();
        }
        const processRef = this.process;
        this.process = null;
        if (processRef) {
            processRef.removeAllListeners();
        }
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(reason));
        }
        this.pending.clear();
        if (!this.closing && hadConnection) {
            this.emit("closed", reason);
        }
    }
}
//# sourceMappingURL=codex-app-server-client.js.map