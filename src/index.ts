#!/usr/bin/env node

import { Command, type Command as CommanderCommand } from "commander";
import { configureLogger } from "./lib/logger.js";
import { printBanner } from "./lib/banner.js";
import { CLI_VERSION } from "./lib/version.js";

// Display OpenRemote banner
printBanner();

const program = new Command();

function withCliContext(action: () => Promise<void> | void) {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as CommanderCommand;
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
  .action(
    withCliContext(async () => {
      const { setupCommand } = await import("./commands/setup.js");
      await setupCommand();
    }),
  );

program
  .command("login")
  .description("Authenticate via browser and associate this machine to your account")
  .action(
    withCliContext(async () => {
      const { loginCommand } = await import("./commands/login.js");
      await loginCommand();
    }),
  );

program
  .command("start")
  .description("Connect to the backend and accept remote Codex sessions")
  .action(
    withCliContext(async () => {
      const { startCommand } = await import("./commands/start.js");
      await startCommand();
    }),
  );

program
  .command("status")
  .description("Show current configuration, credentials, and readiness")
  .action(
    withCliContext(async () => {
      const { statusCommand } = await import("./commands/status.js");
      await statusCommand();
    }),
  );

program
  .command("doctor")
  .description("Run diagnostics on your environment and configuration")
  .action(
    withCliContext(async () => {
      const { doctorCommand } = await import("./commands/doctor.js");
      await doctorCommand();
    }),
  );

program
  .command("logout")
  .description("Remove auth token and optionally the API key")
  .action(
    withCliContext(async () => {
      const { logoutCommand } = await import("./commands/logout.js");
      await logoutCommand();
    }),
  );

program.parse();
