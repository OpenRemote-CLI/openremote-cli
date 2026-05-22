import chalk from "chalk";
import { TerminalUI } from "./terminal-ui.js";
const SECRET_PATTERNS = [
    /sk-[a-zA-Z0-9_-]{20,}/g,
    /eyJ[a-zA-Z0-9_-]{20,}/g,
    /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
    /\b(API_KEY|TOKEN|SECRET)\s*=\s*[^\s"']+/gi,
];
function timeStamp() {
    return new Date().toISOString().slice(11, 23);
}
function mask(msg) {
    let result = msg;
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, "***");
    }
    return result;
}
const ui = new TerminalUI();
export function configureLogger(options = {}) {
    ui.configure(options);
}
export const log = {
    header(title) {
        ui.showHeader(title);
    },
    setDashboard(data) {
        ui.setDashboard(data);
    },
    clearDashboard() {
        ui.clearDashboard();
    },
    infoBar(text, tone = "info") {
        ui.setInfoBar(mask(text), tone);
    },
    clearInfoBar() {
        ui.clearInfoBar();
    },
    status(msg, tone = "warning") {
        ui.setStatus(mask(msg), tone);
    },
    step(msg) {
        ui.setStatus(mask(msg), "warning");
    },
    ok(msg) {
        ui.succeedStatus(mask(msg));
    },
    warn(msg) {
        ui.note(mask(msg), "warning");
    },
    error(msg) {
        ui.failStatus(mask(msg));
    },
    info(msg) {
        ui.note(mask(msg), "neutral");
    },
    note(msg, tone = "neutral") {
        ui.note(mask(msg), tone);
    },
    card(title, lines, tone = "neutral") {
        ui.card(title, lines.map(mask), tone);
    },
    summary(title, rows) {
        ui.summary(title, rows.map(([label, value]) => [label, mask(value)]));
    },
    checklist(title, rows) {
        ui.checklist(title, rows.map((row) => ({
            ...row,
            detail: mask(row.detail),
        })));
    },
    nextStep(text) {
        ui.card("Next step", [chalk.white(mask(text))], "info");
    },
    debug(msg) {
        ui.debug(`${timeStamp()} ${mask(msg)}`);
    },
    clearStatus() {
        ui.stopStatus();
    },
    shutdown() {
        ui.shutdown();
    },
};
//# sourceMappingURL=logger.js.map