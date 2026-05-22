import boxen from "boxen";
import chalk from "chalk";
import { createLogUpdate } from "log-update";
const SPINNER_FRAMES = [
    "\u280b",
    "\u2819",
    "\u2839",
    "\u2838",
    "\u283c",
    "\u2834",
    "\u2826",
    "\u2827",
    "\u2807",
    "\u280f",
];
const DEFAULT_DASHBOARD = {
    machineId: "-",
    user: "Unknown",
    machineStatus: "offline",
    activeSessions: 0,
    sessionId: "-",
    sessionState: "idle",
    sessionDetail: "Waiting for a session",
    providerName: "-",
    modelName: "-",
    reasoning: "-",
    approvalMode: "-",
    tips: [
        "Open the OpenRemote app on your iPhone.",
        "Select this machine in the app.",
        "Choose a repository and send your first prompt.",
    ],
};
function colorForTone(tone) {
    switch (tone) {
        case "success":
            return chalk.green;
        case "warning":
            return chalk.yellow;
        case "danger":
            return chalk.red;
        case "info":
            return chalk.cyan;
        default:
            return chalk.white;
    }
}
function borderColorForTone(tone) {
    switch (tone) {
        case "success":
            return "green";
        case "warning":
            return "yellow";
        case "danger":
            return "red";
        case "info":
            return "cyan";
        default:
            return "gray";
    }
}
function visibleWidth(value) {
    return value.replace(/\u001B\[[0-9;]*m/g, "").length;
}
function padRight(value, width) {
    return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}
function joinHorizontal(blocks, gap = 2) {
    const chunks = blocks.map((block) => block.split("\n"));
    const widths = chunks.map((lines) => Math.max(...lines.map(visibleWidth)));
    const height = Math.max(...chunks.map((lines) => lines.length));
    const rows = [];
    for (let row = 0; row < height; row += 1) {
        rows.push(chunks
            .map((lines, index) => padRight(lines[row] ?? "", widths[index]))
            .join(" ".repeat(gap))
            .trimEnd());
    }
    return rows.join("\n");
}
export class TerminalUI {
    logUpdate = createLogUpdate(process.stdout, { showCursor: false });
    useDynamicOutput = Boolean(process.stdout.isTTY);
    useUnicode = Boolean(process.stdout.isTTY);
    statusState = null;
    statusTimer = null;
    spinnerIndex = 0;
    dotIndex = 0;
    verbose = false;
    headerTitle = "OpenRemote";
    dashboard = null;
    infoBar = null;
    headerPrinted = false;
    dashboardPrinted = false;
    lastRenderedDashboard = null;
    configure(options = {}) {
        this.verbose = Boolean(options.verbose);
    }
    showHeader(title = "OpenRemote") {
        this.headerTitle = title;
        if (!this.dashboard) {
            process.stdout.write(`${this.renderHeader()}\n`);
            this.headerPrinted = true;
            return;
        }
        this.renderOrWrite();
    }
    setDashboard(data) {
        this.dashboard = {
            ...(this.dashboard ?? DEFAULT_DASHBOARD),
            ...data,
            tips: data.tips ?? this.dashboard?.tips ?? DEFAULT_DASHBOARD.tips,
        };
        this.renderOrWrite();
    }
    clearDashboard() {
        this.dashboard = null;
        this.dashboardPrinted = false;
        this.renderOrWrite();
    }
    setInfoBar(text, tone = "info") {
        this.infoBar = { text, tone };
        this.renderOrWrite();
    }
    clearInfoBar() {
        this.infoBar = null;
        this.renderOrWrite();
    }
    setStatus(text, tone = "warning", options = {}) {
        this.statusState = {
            text: text.replace(/[. ]+$/g, ""),
            tone,
            dots: options.dots ?? true,
            mode: "spinner",
        };
        if (!this.useDynamicOutput && !this.dashboard) {
            process.stdout.write(`${this.renderStatusLine()}\n`);
            return;
        }
        if (!this.statusTimer) {
            this.renderOrWrite();
            this.statusTimer = setInterval(() => {
                this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
                this.dotIndex = (this.dotIndex + 1) % 4;
                this.renderOrWrite();
            }, 90);
            return;
        }
        this.renderOrWrite();
    }
    stopStatus() {
        if (this.statusTimer) {
            clearInterval(this.statusTimer);
            this.statusTimer = null;
        }
        if (this.useDynamicOutput && this.dashboard) {
            this.logUpdate.clear();
        }
        this.statusState = null;
        this.spinnerIndex = 0;
        this.dotIndex = 0;
    }
    succeedStatus(text) {
        this.persistStatus("✓", text, "success");
    }
    failStatus(text) {
        this.persistStatus("✕", text, "danger");
    }
    note(text, tone = "neutral") {
        this.appendBlock(`${colorForTone(tone)(this.useUnicode ? "•" : "-")} ${chalk.white(text)}`);
    }
    debug(text) {
        if (!this.verbose)
            return;
        if (this.dashboard) {
            this.writeDashboardBlock(chalk.dim(`[debug] ${text}`));
            return;
        }
        process.stdout.write(`${chalk.dim(`[debug] ${text}`)}\n`);
    }
    card(title, lines, tone = "neutral") {
        const filtered = lines.map((line) => line.trimEnd()).filter(Boolean);
        const body = [
            chalk.bold(colorForTone(tone)(title)),
            ...(filtered.length > 0 ? ["", ...filtered] : []),
        ].join("\n");
        this.appendBlock(boxen(body, {
            padding: { top: 0, bottom: 0, left: 1, right: 1 },
            margin: { top: 0, bottom: 1, left: 0, right: 0 },
            borderStyle: "round",
            borderColor: borderColorForTone(tone),
        }));
    }
    summary(title, rows) {
        const maxLabel = Math.max(...rows.map(([label]) => label.length + 1));
        const lines = rows.map(([label, value]) => {
            const padded = `${label}:`.padEnd(maxLabel);
            return `${chalk.gray(padded)} ${chalk.white(value)}`;
        });
        this.card(title, lines, "neutral");
    }
    checklist(title, rows) {
        const lines = rows.flatMap((row) => {
            const icon = row.ok ? chalk.green("✓") : chalk.red("✕");
            return [
                `${icon} ${chalk.white(row.label)}`,
                `${chalk.gray("  ")}${chalk.gray(row.detail)}`,
            ];
        });
        this.card(title, lines, "neutral");
    }
    shutdown() {
        this.stopStatus();
        if (this.useDynamicOutput) {
            this.logUpdate.done();
        }
    }
    persistStatus(icon, text, tone) {
        if (this.statusTimer) {
            clearInterval(this.statusTimer);
            this.statusTimer = null;
        }
        this.statusState = {
            text,
            tone,
            dots: false,
            mode: "static",
            icon,
        };
        this.renderOrWrite();
    }
    appendBlock(text) {
        if (this.dashboard) {
            this.writeDashboardBlock(text);
            return;
        }
        this.stopStatus();
        process.stdout.write(`${text}\n`);
    }
    renderOrWrite() {
        if (!this.dashboard || !this.useDynamicOutput) {
            if (this.statusState && this.useDynamicOutput) {
                this.logUpdate(this.renderStatusLine());
            }
            else if (!this.headerPrinted) {
                process.stdout.write(`${this.renderHeader()}\n`);
                this.headerPrinted = true;
            }
            return;
        }
        // Render the full dashboard
        const sections = [
            this.renderHeader(),
            this.renderDashboard(),
            this.infoBar ? this.renderInfoBar() : null,
        ].filter(Boolean);
        let dashboardText = `${sections.join("\n\n")}\n\n`;
        // Append status line if it exists
        if (this.statusState) {
            dashboardText += this.renderStatusLine();
        }
        // Only render if content has changed
        if (this.lastRenderedDashboard !== dashboardText) {
            this.logUpdate(dashboardText);
            this.lastRenderedDashboard = dashboardText;
            this.dashboardPrinted = true;
        }
    }
    writeDashboardBlock(text) {
        if (!this.dashboard || !this.useDynamicOutput) {
            process.stdout.write(`${text}\n`);
            return;
        }
        this.logUpdate.clear();
        process.stdout.write(`${text}\n\n`);
        if (this.statusState) {
            this.logUpdate(this.renderStatusLine());
        }
    }
    renderHeader() {
        return chalk.gray("Download the App OpenRemote on the Appstore or on the Playstore") + "\n";
    }
    renderDashboard() {
        if (!this.dashboard)
            return "";
        const columns = process.stdout.columns ?? 120;
        const machineSessionCard = this.makeMachineSessionCard(columns);
        const activeSessionsLine = this.makeActiveSessionsLine();
        const machineConnectedCard = this.makeMachineConnectedCard(columns);
        const modelCard = this.makeModelCard(columns);
        const tipsCard = this.makeTipsCard(this.dashboard.tips, columns);
        if (columns >= 110) {
            const topRow = joinHorizontal([machineSessionCard, [modelCard, tipsCard].join("\n\n")], 2);
            return [topRow, activeSessionsLine, machineConnectedCard].join("\n\n");
        }
        return [machineSessionCard, modelCard, tipsCard, activeSessionsLine, machineConnectedCard].join("\n\n");
    }
    makeActiveSessionsLine() {
        if (!this.dashboard)
            return "";
        return `${chalk.white("Active sessions:")} ${chalk.cyanBright.bold(String(this.dashboard.activeSessions))}`;
    }
    makeMachineSessionCard(columns) {
        if (!this.dashboard)
            return "";
        const rows = [
            ["Machine", this.dashboard.machineId],
            ["User", this.dashboard.user],
            ["Status", this.dashboard.machineStatus],
            ["Session", this.dashboard.sessionId],
            ["State", this.dashboard.sessionState],
            ["Detail", this.dashboard.sessionDetail],
        ];
        const maxLabel = Math.max(...rows.map(([label]) => label.length + 1));
        const lines = rows.map(([label, value], index) => {
            const padded = `${label}:`.padEnd(maxLabel);
            const line = `${chalk.cyanBright(padded)} ${chalk.white(value)}`;
            return index === 3
                ? `${chalk.gray("─".repeat(36))}\n${line}`
                : line;
        });
        return boxen(lines.join("\n"), {
            padding: { top: 0, bottom: 0, left: 1, right: 2 },
            borderStyle: "round",
            borderColor: "cyan",
            width: columns >= 110 ? Math.min(Math.max(Math.floor(columns * 0.62), 60), 80) : undefined,
        });
    }
    makeModelCard(columns) {
        if (!this.dashboard)
            return "";
        const sepWidth = columns >= 110
            ? Math.min(Math.max(Math.floor(columns * 0.36) - 4, 34), 48)
            : 38;
        const rows = [
            ["Platform", this.dashboard.providerName],
            ["Model", this.dashboard.modelName],
            ["Reasoning", this.dashboard.reasoning],
        ];
        const maxLabel = Math.max(...rows.map(([label]) => label.length + 1));
        const lines = rows.map(([label, value]) => {
            const padded = `${label}:`.padEnd(maxLabel);
            return `  ${chalk.magentaBright(padded)} ${chalk.white(value)}`;
        });
        return [
            lines[0],
            `  ${chalk.gray("─".repeat(sepWidth))}`,
            lines[1],
            lines[2],
        ].join("\n");
    }
    makeMachineConnectedCard(columns) {
        if (!this.dashboard)
            return "";
        const isConnected = ["connected", "online"].includes(this.dashboard.machineStatus.toLowerCase());
        const isBusyOrIdle = ["idle"].includes(this.dashboard.machineStatus.toLowerCase());
        const isActive = isConnected || isBusyOrIdle;
        const dot = isActive ? chalk.greenBright("●") : chalk.yellow("○");
        const title = isActive ? "Machine connected" : "Machine status";
        const detail = isActive
            ? "Your machine is connected and ready."
            : `Current status: ${this.dashboard.machineStatus}`;
        const sepWidth = Math.min(columns - 2, 74);
        return [
            `${dot} ${chalk.bold.green(title)}`,
            chalk.gray("─".repeat(sepWidth)),
            chalk.white(detail),
        ].join("\n");
    }
    makeTipsCard(tips, columns) {
        const colWidth = columns >= 110
            ? Math.min(Math.max(Math.floor(columns * 0.36) - 4, 34), 48)
            : 38;
        const sepWidth = colWidth - 2;
        const wrapTip = (index, tip) => {
            const prefix = `${index + 1}. `;
            const indent = " ".repeat(prefix.length);
            // Available chars for the tip text itself (colWidth minus "  N. " prefix)
            const textWidth = Math.max(colWidth - 2 - prefix.length, 10);
            const words = tip.split(" ");
            const rawLines = [];
            let current = "";
            for (const word of words) {
                if (current === "") {
                    current = word;
                }
                else if ((current + " " + word).length <= textWidth) {
                    current += " " + word;
                }
                else {
                    rawLines.push(current);
                    current = word;
                }
            }
            if (current)
                rawLines.push(current);
            return [
                `  ${prefix}${rawLines[0] ?? ""}`,
                ...rawLines.slice(1).map((l) => `  ${indent}${l}`),
            ].join("\n");
        };
        return [
            `  ${chalk.bold.yellow("Tips")}`,
            `  ${chalk.gray("─".repeat(Math.min(sepWidth, 46)))}`,
            ...tips.map((tip, index) => chalk.white(wrapTip(index, tip))),
        ].join("\n");
    }
    renderStatusLine() {
        if (!this.statusState)
            return "";
        const painter = colorForTone(this.statusState.tone);
        if (this.statusState.mode === "static") {
            return `${painter(this.statusState.icon ?? "•")} ${chalk.white(this.statusState.text)}`;
        }
        const spinner = this.useUnicode ? SPINNER_FRAMES[this.spinnerIndex] : ">";
        const dots = this.statusState.dots ? ".".repeat(this.dotIndex) : "";
        return `${painter(spinner)} ${chalk.white(this.statusState.text)}${chalk.gray(dots)}`;
    }
    renderInfoBar() {
        if (!this.infoBar)
            return "";
        return boxen(chalk.white(this.infoBar.text), {
            padding: { top: 0, bottom: 0, left: 1, right: 1 },
            borderStyle: "round",
            borderColor: borderColorForTone(this.infoBar.tone),
        });
    }
}
//# sourceMappingURL=terminal-ui.js.map