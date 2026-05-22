import { log } from "../lib/logger.js";
import { updateConfig } from "../lib/config.js";
import {
  clearAuthToken,
  hasAuthToken,
} from "../lib/credentials.js";

export async function logoutCommand(): Promise<void> {
  log.header("OpenRemote");

  if (!hasAuthToken()) {
    log.card("You're already signed out", ["No machine token is stored on this machine."], "warning");
    return;
  }

  clearAuthToken();

  updateConfig({ userDisplayName: null });

  log.ok("Signed out");
  log.card(
    "Local credentials updated",
    ["Removed machine token."],
    "success",
  );
  log.nextStep("Run openremote login when you're ready");
}
