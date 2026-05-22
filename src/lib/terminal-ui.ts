import boxen from "boxen";
import chalk from "chalk";
import gradient from "gradient-string";
import { createLogUpdate } from "log-update";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

interface StatusState {
  text: string;
  tone: Tone;
  dots: boolean;
  mode: "spinner" | "static";
  icon?: string;
}

export interface DashboardState {
  machineId: string;
  user: string;
  machineStatus: string;
  activeSessions: number;
  sessionId: string;
  sessionState: string;
  sessionDetail: string;
  providerName: string;
  modelName: string;
  reasoning: string;
  approvalMode: string;
  tips: string[];
}

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

const DEFAULT_DASHBOARD: DashboardState = {
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

function colorForTone(tone: Tone) {
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

function borderColorForTone(tone: Tone) {
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

function visibleWidth(value: string): number {
  return value.replace(/\u001B\[[0-9;]*m/g, "").length;
}

function padRight(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function joinHorizontal(blocks: string[], gap = 2): string {
  const chunks = blocks.map((block) => block.split("\n"));
  const widths = chunks.map((lines) => Math.max(...lines.map(visibleWidth)));
  const height = Math.max(...chunks.map((lines) => lines.length));
  const rows: string[] = [];

  for (let row = 0; row < height; row += 1) {
    rows.push(
      chunks
        .map((lines, index) => padRight(lines[row] ?? "", widths[index]))
        .join(" ".repeat(gap))
        .trimEnd(),
    );
  }

  return rows.join("\n");
}

export class TerminalUI {
  private readonly logUpdate = createLogUpdate(process.stdout, { showCursor: false });
  private readonly useDynamicOutput = Boolean(process.stdout.isTTY);
  private readonly useUnicode = Boolean(process.stdout.isTTY);
  private statusState: StatusState | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerIndex = 0;
  private dotIndex = 0;
  private verbose = false;
  private headerTitle = "OpenRemote";
  private dashboard: DashboardState | null = null;
  private infoBar: { text: string; tone: Tone } | null = null;
  private headerPrinted = false;
  private dashboardPrinted = false;
  private lastRenderedDashboard: string | null = null;

  configure(options: { verbose?: boolean } = {}): void {
    this.verbose = Boolean(options.verbose);
  }

  showHeader(title = "OpenRemote"): void {
    this.headerTitle = title;
    if (!this.dashboard) {
      process.stdout.write(`${this.renderHeader()}\n`);
      this.headerPrinted = true;
      return;
    }
    this.renderOrWrite();
  }

  setDashboard(data: Partial<DashboardState>): void {
    this.dashboard = {
      ...(this.dashboard ?? DEFAULT_DASHBOARD),
      ...data,
      tips: data.tips ?? this.dashboard?.tips ?? DEFAULT_DASHBOARD.tips,
    };
    this.renderOrWrite();
  }

  clearDashboard(): void {
    this.dashboard = null;
    this.dashboardPrinted = false;
    this.renderOrWrite();
  }

  setInfoBar(text: string, tone: Tone = "info"): void {
    this.infoBar = { text, tone };
    this.renderOrWrite();
  }

  clearInfoBar(): void {
    this.infoBar = null;
    this.renderOrWrite();
  }

  setStatus(text: string, tone: Tone = "warning", options: { dots?: boolean } = {}): void {
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

  stopStatus(): void {
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

  succeedStatus(text: string): void {
    this.persistStatus("✓", text, "success");
  }

  failStatus(text: string): void {
    this.persistStatus("✕", text, "danger");
  }

  note(text: string, tone: Tone = "neutral"): void {
    this.appendBlock(`${colorForTone(tone)(this.useUnicode ? "•" : "-")} ${chalk.white(text)}`);
  }

  debug(text: string): void {
    if (!this.verbose) return;

    if (this.dashboard) {
      this.writeDashboardBlock(chalk.dim(`[debug] ${text}`));
      return;
    }

    process.stdout.write(`${chalk.dim(`[debug] ${text}`)}\n`);
  }

  card(title: string, lines: string[], tone: Tone = "neutral"): void {
    const filtered = lines.map((line) => line.trimEnd()).filter(Boolean);
    const body = [
      chalk.bold(colorForTone(tone)(title)),
      ...(filtered.length > 0 ? ["", ...filtered] : []),
    ].join("\n");

    this.appendBlock(
      boxen(body, {
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        margin: { top: 0, bottom: 1, left: 0, right: 0 },
        borderStyle: "round",
        borderColor: borderColorForTone(tone),
      }),
    );
  }

  summary(title: string, rows: Array<[string, string]>): void {
    const maxLabel = Math.max(...rows.map(([label]) => label.length + 1));
    const lines = rows.map(([label, value]) => {
      const padded = `${label}:`.padEnd(maxLabel);
      return `${chalk.gray(padded)} ${chalk.white(value)}`;
    });
    this.card(title, lines, "neutral");
  }

  checklist(title: string, rows: Array<{ label: string; detail: string; ok: boolean }>): void {
    const lines = rows.flatMap((row) => {
      const icon = row.ok ? chalk.green("✓") : chalk.red("✕");
      return [
        `${icon} ${chalk.white(row.label)}`,
        `${chalk.gray("  ")}${chalk.gray(row.detail)}`,
      ];
    });
    this.card(title, lines, "neutral");
  }

  shutdown(): void {
    this.stopStatus();
    if (this.useDynamicOutput) {
      this.logUpdate.done();
    }
  }

  private persistStatus(icon: string, text: string, tone: Tone): void {
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

  private appendBlock(text: string): void {
    if (this.dashboard) {
      this.writeDashboardBlock(text);
      return;
    }

    this.stopStatus();
    process.stdout.write(`${text}\n`);
  }

  private renderOrWrite(): void {
    if (!this.dashboard || !this.useDynamicOutput) {
      if (this.statusState && this.useDynamicOutput) {
        this.logUpdate(this.renderStatusLine());
      } else if (!this.headerPrinted) {
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
    ].filter(Boolean) as string[];
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

  private writeDashboardBlock(text: string): void {
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

  private renderHeader(): string {
    return chalk.gray("Download the App OpenRemote on the Appstore or on the Playstore") + "\n";
  }

  private renderDashboard(): string {
    if (!this.dashboard) return "";

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

  private makeActiveSessionsLine(): string {
    if (!this.dashboard) return "";
    return `${chalk.white("Active sessions:")} ${chalk.cyanBright.bold(String(this.dashboard.activeSessions))}`;
  }

  private makeMachineSessionCard(columns: number): string {
    if (!this.dashboard) return "";

    const rows: Array<[string, string]> = [
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

  private makeModelCard(columns: number): string {
    if (!this.dashboard) return "";

    const sepWidth = columns >= 110
      ? Math.min(Math.max(Math.floor(columns * 0.36) - 4, 34), 48)
      : 38;
    const rows: Array<[string, string]> = [
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

  private makeMachineConnectedCard(columns: number): string {
    if (!this.dashboard) return "";

    const isConnected = ["connected", "online"].includes(
      this.dashboard.machineStatus.toLowerCase(),
    );
    const isBusyOrIdle = ["idle"].includes(
      this.dashboard.machineStatus.toLowerCase(),
    );
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

  private makeTipsCard(tips: string[], columns: number): string {
    const colWidth = columns >= 110
      ? Math.min(Math.max(Math.floor(columns * 0.36) - 4, 34), 48)
      : 38;
    const sepWidth = colWidth - 2;

    const wrapTip = (index: number, tip: string): string => {
      const prefix = `${index + 1}. `;
      const indent = " ".repeat(prefix.length);
      // Available chars for the tip text itself (colWidth minus "  N. " prefix)
      const textWidth = Math.max(colWidth - 2 - prefix.length, 10);
      const words = tip.split(" ");
      const rawLines: string[] = [];
      let current = "";
      for (const word of words) {
        if (current === "") {
          current = word;
        } else if ((current + " " + word).length <= textWidth) {
          current += " " + word;
        } else {
          rawLines.push(current);
          current = word;
        }
      }
      if (current) rawLines.push(current);
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

  private renderStatusLine(): string {
    if (!this.statusState) return "";

    const painter = colorForTone(this.statusState.tone);
    if (this.statusState.mode === "static") {
      return `${painter(this.statusState.icon ?? "•")} ${chalk.white(this.statusState.text)}`;
    }

    const spinner = this.useUnicode ? SPINNER_FRAMES[this.spinnerIndex] : ">";
    const dots = this.statusState.dots ? ".".repeat(this.dotIndex) : "";
    return `${painter(spinner)} ${chalk.white(this.statusState.text)}${chalk.gray(dots)}`;
  }

  private renderInfoBar(): string {
    if (!this.infoBar) return "";

    return boxen(chalk.white(this.infoBar.text), {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      borderStyle: "round",
      borderColor: borderColorForTone(this.infoBar.tone),
    });
  }

}
