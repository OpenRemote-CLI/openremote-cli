import { log } from "../lib/logger.js";
import { loadConfig, getConfigPath } from "../lib/config.js";
import { hasAuthToken } from "../lib/credentials.js";
import { checkCodexCli } from "../lib/checks.js";
export async function statusCommand() {
    log.header("OpenRemote");
    const config = loadConfig();
    const codex = checkCodexCli();
    log.summary("Current status", [
        ["Machine", config?.machineId ? `${config.machineId.slice(0, 8)}...` : "Not configured"],
        ["User", config?.userDisplayName ?? "Not logged in"],
        ["Config file", getConfigPath()],
        ["Codex CLI", codex.ok ? codex.detail : "Missing"],
        ["Machine token", hasAuthToken() ? "Stored" : "Missing"],
        ["Last seen", config?.lastSeenAt ?? "Never"],
    ]);
    const ready = Boolean(config?.machineId &&
        hasAuthToken() &&
        codex.ok);
    if (ready) {
        log.card("Ready to start", ["Run openremote start"], "success");
        return;
    }
    const missing = [];
    if (!config?.machineId) {
        missing.push("setup");
    }
    if (!hasAuthToken())
        missing.push("login");
    if (!codex.ok)
        missing.push("Codex CLI");
    log.card("Not ready yet", [`Missing: ${missing.join(", ")}`], "warning");
}
//# sourceMappingURL=status.js.map