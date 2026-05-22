import { type DashboardState } from "./terminal-ui.js";
export declare function configureLogger(options?: {
    verbose?: boolean;
}): void;
export declare const log: {
    header(title: string): void;
    setDashboard(data: Partial<DashboardState>): void;
    clearDashboard(): void;
    infoBar(text: string, tone?: "neutral" | "success" | "warning" | "danger" | "info"): void;
    clearInfoBar(): void;
    status(msg: string, tone?: "neutral" | "success" | "warning" | "danger" | "info"): void;
    step(msg: string): void;
    ok(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    info(msg: string): void;
    note(msg: string, tone?: "neutral" | "success" | "warning" | "danger" | "info"): void;
    card(title: string, lines: string[], tone?: "neutral" | "success" | "warning" | "danger" | "info"): void;
    summary(title: string, rows: Array<[string, string]>): void;
    checklist(title: string, rows: Array<{
        label: string;
        detail: string;
        ok: boolean;
    }>): void;
    nextStep(text: string): void;
    debug(msg: string): void;
    clearStatus(): void;
    shutdown(): void;
};
