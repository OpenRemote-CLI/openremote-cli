import { v4 as uuidv4 } from "uuid";
import { log } from "../lib/logger.js";
import { confirm } from "../lib/prompt.js";
import { checkCodexCli, checkClaudeCodeCli, checkQwenCli } from "../lib/checks.js";
import { saveConfig, loadConfig } from "../lib/config.js";
import type { AppConfig } from "../lib/types.js";
import { CLI_VERSION } from "../lib/version.js";

const DEFAULT_SUPABASE_URL = "https://wlnvrceomzpouwsluqpk.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndsbnZyY2VvbXpwb3V3c2x1cXBrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4NTMwNDcsImV4cCI6MjA5MTQyOTA0N30.WeJWa6UBvnhwfrJEPtty3uNqt1nKjzRvhNQGjGPVsWg";

export async function setupCommand(): Promise<void> {
  log.header("OpenRemote");
  log.step("Checking your environment");

  const codexCheck = checkCodexCli();
  const claudeCodeCheck = checkClaudeCodeCli();
  const qwenCheck = checkQwenCli();

  log.ok("Environment checked");
  log.checklist("Checks", [
    { label: codexCheck.name, detail: codexCheck.detail, ok: codexCheck.ok },
    { label: claudeCodeCheck.name, detail: claudeCodeCheck.detail, ok: claudeCodeCheck.ok },
    { label: qwenCheck.name, detail: qwenCheck.detail, ok: qwenCheck.ok },
  ]);

  const missingCliTools: string[] = [];
  if (!codexCheck.ok) missingCliTools.push(codexCheck.detail);
  if (!claudeCodeCheck.ok) missingCliTools.push(claudeCodeCheck.detail);
  if (!qwenCheck.ok) missingCliTools.push(qwenCheck.detail);

  if (missingCliTools.length > 0) {
    log.card(
      "Some CLI tools are missing",
      ["Install the following tools:", "", ...missingCliTools, "", "Then run openremote setup again."],
      "warning",
    );
  }

  log.card(
    "Security notice",
    [
      "Remote sessions can access any local path on this machine.",
      "Only use OpenRemote on trusted networks with trusted users.",
    ],
    "warning",
  );

  const accepted = await confirm("Continue with this setup?");
  if (!accepted) {
    log.card("Setup cancelled", ["No changes were applied."], "warning");
    process.exit(0);
  }

  const existingConfig = loadConfig();
  const config: AppConfig = {
    machineId: existingConfig?.machineId ?? uuidv4(),
    supabaseUrl: DEFAULT_SUPABASE_URL,
    supabaseAnonKey: DEFAULT_SUPABASE_ANON_KEY,
    userDisplayName: existingConfig?.userDisplayName ?? null,
    createdAt: existingConfig?.createdAt ?? new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    cliVersion: CLI_VERSION,
    backendUrl: DEFAULT_SUPABASE_URL,
  };

  saveConfig(config);

  log.summary("Setup complete", [
    ["Machine", `${config.machineId.slice(0, 8)}...`],
    ["Status", "ready"],
  ]);
  log.nextStep("Run openremote login");
}
