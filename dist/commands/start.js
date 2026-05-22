import { log } from "../lib/logger.js";
import { loadConfig, updateConfig } from "../lib/config.js";
import { getAuthToken } from "../lib/credentials.js";
import { getSupportedProviders } from "../lib/checks.js";
import { Bridge } from "../lib/bridge.js";
import { SessionManager } from "../lib/session.js";
export async function startCommand() {
    const config = loadConfig();
    if (!config) {
        log.header("OpenRemote");
        log.card("Couldn't start", ["Run openremote setup first."], "danger");
        process.exit(1);
    }
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
        log.header("OpenRemote");
        log.card("Missing backend config", ["Run openremote setup again."], "danger");
        process.exit(1);
    }
    const machineToken = getAuthToken();
    if (!machineToken) {
        log.header("OpenRemote");
        log.card("You're not logged in", ["Run openremote login."], "danger");
        process.exit(1);
    }
    const supportedProviders = getSupportedProviders();
    if (supportedProviders.length === 0) {
        log.header("OpenRemote");
        log.card("No supported CLI found", [
            "Install Codex with: npm install -g @openai/codex",
            "Or install Qwen with: npm install -g @alibaba-cloud/qwen-cli",
        ], "danger");
        process.exit(1);
    }
    log.setDashboard({
        machineId: `${config.machineId.slice(0, 8)}...`,
        user: config.userDisplayName ?? "Unknown",
        machineStatus: "connecting",
        sessionId: "-",
        sessionState: "idle",
        sessionDetail: "Waiting for a remote session",
        providerName: "-",
        modelName: "-",
        reasoning: "-",
        approvalMode: "-",
        tips: [
            "Open the OpenRemote app on your iPhone.",
            "Select this machine in the app.",
            "Choose a repository and send your first prompt.",
        ],
    });
    log.header("OpenRemote");
    log.step("Connecting to your machine");
    const apiKey = process.env.OPENAI_API_KEY || "";
    const bridge = new Bridge(config, machineToken, supportedProviders);
    const sessions = new SessionManager(bridge, apiKey, supportedProviders, config);
    bridge.on("connected", () => {
        updateConfig({ lastSeenAt: new Date().toISOString() });
        log.setDashboard({
            machineStatus: "connected",
            sessionDetail: "Syncing with the backend",
        });
        log.ok("Connected to your machine");
    });
    bridge.on("ready", () => {
        log.setDashboard({
            machineStatus: "online",
            sessionState: "idle",
            sessionDetail: "Waiting for a remote session",
            tips: [
                "Open the OpenRemote app on your iPhone.",
                "Select this machine in the app.",
                "Choose a repository and send your first prompt.",
            ],
        });
        log.clearInfoBar();
        log.step("Waiting for a session");
    });
    bridge.on("disconnected", () => {
        log.setDashboard({
            machineStatus: "reconnecting",
            sessionDetail: "Trying to reconnect",
        });
        log.infoBar("Connection lost. Reconnecting automatically.", "warning");
        log.status("Reconnecting to your machine", "warning");
    });
    bridge.on("message", (msg) => {
        sessions.handleMessage(msg);
    });
    bridge.connect();
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        log.setDashboard({
            machineStatus: "offline",
            sessionState: "offline",
            sessionDetail: "Shutting down",
        });
        log.step("Disconnecting");
        sessions.shutdown();
        await bridge.disconnect();
        log.clearInfoBar();
        log.ok("Machine offline");
        log.shutdown();
        process.exit(0);
    };
    process.on("SIGINT", () => {
        void shutdown();
    });
    process.on("SIGTERM", () => {
        void shutdown();
    });
    await new Promise(() => { });
}
//# sourceMappingURL=start.js.map