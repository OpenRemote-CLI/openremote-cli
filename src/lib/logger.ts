import chalk from "chalk";
import { TerminalUI, type DashboardState } from "./terminal-ui.js";

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /eyJ[a-zA-Z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
  /\b(API_KEY|TOKEN|SECRET)\s*=\s*[^\s"']+/gi,
];

function timeStamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function mask(msg: string): string {
  let result = msg;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "***");
  }
  return result;
}

const ui = new TerminalUI();

export function configureLogger(options: { verbose?: boolean } = {}): void {
  ui.configure(options);
}

export const log = {
  header(title: string) {
    ui.showHeader(title);
  },
  setDashboard(data: Partial<DashboardState>) {
    ui.setDashboard(data);
  },
  clearDashboard() {
    ui.clearDashboard();
  },
  infoBar(text: string, tone: "neutral" | "success" | "warning" | "danger" | "info" = "info") {
    ui.setInfoBar(mask(text), tone);
  },
  clearInfoBar() {
    ui.clearInfoBar();
  },
  status(msg: string, tone: "neutral" | "success" | "warning" | "danger" | "info" = "warning") {
    ui.setStatus(mask(msg), tone);
  },
  step(msg: string) {
    ui.setStatus(mask(msg), "warning");
  },
  ok(msg: string) {
    ui.succeedStatus(mask(msg));
  },
  warn(msg: string) {
    ui.note(mask(msg), "warning");
  },
  error(msg: string) {
    ui.failStatus(mask(msg));
  },
  info(msg: string) {
    ui.note(mask(msg), "neutral");
  },
  note(msg: string, tone: "neutral" | "success" | "warning" | "danger" | "info" = "neutral") {
    ui.note(mask(msg), tone);
  },
  card(
    title: string,
    lines: string[],
    tone: "neutral" | "success" | "warning" | "danger" | "info" = "neutral",
  ) {
    ui.card(title, lines.map(mask), tone);
  },
  summary(title: string, rows: Array<[string, string]>) {
    ui.summary(
      title,
      rows.map(([label, value]) => [label, mask(value)]),
    );
  },
  checklist(title: string, rows: Array<{ label: string; detail: string; ok: boolean }>) {
    ui.checklist(
      title,
      rows.map((row) => ({
        ...row,
        detail: mask(row.detail),
      })),
    );
  },
  nextStep(text: string) {
    ui.card("Next step", [chalk.white(mask(text))], "info");
  },
  debug(msg: string) {
    ui.debug(`${timeStamp()} ${mask(msg)}`);
  },
  clearStatus() {
    ui.stopStatus();
  },
  shutdown() {
    ui.shutdown();
  },
};
