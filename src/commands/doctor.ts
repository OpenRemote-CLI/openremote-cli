import { log } from "../lib/logger.js";
import { runAllChecks } from "../lib/checks.js";

export async function doctorCommand(): Promise<void> {
  log.header("OpenRemote");
  log.step("Running diagnostics");

  const checks = runAllChecks();
  log.ok("Diagnostics complete");
  log.checklist(
    "Diagnostics",
    checks.map((check) => ({
      label: check.name,
      detail: check.detail,
      ok: check.ok,
    })),
  );

  if (checks.every((check) => check.ok)) {
    log.card("Everything looks good", ["Your machine is ready for OpenRemote."], "success");
    return;
  }

  log.card("Some checks failed", ["Fix the items above, then rerun openremote doctor."], "warning");
}
