#!/usr/bin/env node
import { Command } from "commander";
import { configureLogger } from "./lib/logger.js";
import { printBanner } from "./lib/banner.js";
import { CLI_VERSION } from "./lib/version.js";
// Display OpenRemote banner
printBanner();
// Check for a newer version in the background — never blocks startup.
(async () => {
    try {
        const res = await fetch("https://registry.npmjs.org/openremote/latest", {
            signal: AbortSignal.timeout(4_000),
        });
        if (!res.ok)
            return;
        const data = await res.json();
        const latest = data.version;
        if (!latest || latest === CLI_VERSION)
            return;
        const parse = (v) => v.split(".").map(Number);
        const [lMaj, lMin, lPat] = parse(latest);
        const [cMaj, cMin, cPat] = parse(CLI_VERSION);
        const isNewer = lMaj > cMaj ||
            (lMaj === cMaj && lMin > cMin) ||
            (lMaj === cMaj && lMin === cMin && lPat > cPat);
        if (isNewer) {
            console.log(`\x1b[33m  ╔═══════════════════════════════════════════════════╗\x1b[0m`);
            console.log(`\x1b[33m  ║  Update available: ${CLI_VERSION} → ${latest}`.padEnd(54) + `\x1b[33m║\x1b[0m`);
            console.log(`\x1b[33m  ║  Run: npm install -g openremote@latest            ║\x1b[0m`);
            console.log(`\x1b[33m  ╚═══════════════════════════════════════════════════╝\x1b[0m`);
            console.log();
        }
    }
    catch {
        // Network unavailable or timeout — silently skip
    }
})();
const program = new Command();
function withCliContext(action) {
    return async (...args) => {
        const command = args[args.length - 1];
        configureLogger({ verbose: Boolean(command?.optsWithGlobals?.().verbose) });
        await action();
    };
}
program
    .name("openremote")
    .description("Control OpenAI Codex from your iPhone")
    .version(CLI_VERSION)
    .option("--verbose", "Show debug output below the premium UI");
program
    .command("setup")
    .description("Configure OpenRemote: check CLI dependencies and create config")
    .action(withCliContext(async () => {
    const { setupCommand } = await import("./commands/setup.js");
    await setupCommand();
}));
program
    .command("login")
    .description("Authenticate via browser and associate this machine to your account")
    .action(withCliContext(async () => {
    const { loginCommand } = await import("./commands/login.js");
    await loginCommand();
}));
program
    .command("start")
    .description("Connect to the backend and accept remote Codex sessions")
    .action(withCliContext(async () => {
    const { startCommand } = await import("./commands/start.js");
    await startCommand();
}));
program
    .command("status")
    .description("Show current configuration, credentials, and readiness")
    .action(withCliContext(async () => {
    const { statusCommand } = await import("./commands/status.js");
    await statusCommand();
}));
program
    .command("doctor")
    .description("Run diagnostics on your environment and configuration")
    .action(withCliContext(async () => {
    const { doctorCommand } = await import("./commands/doctor.js");
    await doctorCommand();
}));
program
    .command("logout")
    .description("Remove auth token and optionally the API key")
    .action(withCliContext(async () => {
    const { logoutCommand } = await import("./commands/logout.js");
    await logoutCommand();
}));
program.parse();
//# sourceMappingURL=index.js.map