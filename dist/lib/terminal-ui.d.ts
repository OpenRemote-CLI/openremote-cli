type Tone = "neutral" | "success" | "warning" | "danger" | "info";
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
export declare class TerminalUI {
    private readonly logUpdate;
    private readonly useDynamicOutput;
    private readonly useUnicode;
    private statusState;
    private statusTimer;
    private spinnerIndex;
    private dotIndex;
    private verbose;
    private headerTitle;
    private dashboard;
    private infoBar;
    private headerPrinted;
    private dashboardPrinted;
    private lastRenderedDashboard;
    configure(options?: {
        verbose?: boolean;
    }): void;
    showHeader(title?: string): void;
    setDashboard(data: Partial<DashboardState>): void;
    clearDashboard(): void;
    setInfoBar(text: string, tone?: Tone): void;
    clearInfoBar(): void;
    setStatus(text: string, tone?: Tone, options?: {
        dots?: boolean;
    }): void;
    stopStatus(): void;
    succeedStatus(text: string): void;
    failStatus(text: string): void;
    note(text: string, tone?: Tone): void;
    debug(text: string): void;
    card(title: string, lines: string[], tone?: Tone): void;
    summary(title: string, rows: Array<[string, string]>): void;
    checklist(title: string, rows: Array<{
        label: string;
        detail: string;
        ok: boolean;
    }>): void;
    shutdown(): void;
    private persistStatus;
    private appendBlock;
    private renderOrWrite;
    private writeDashboardBlock;
    private renderHeader;
    private renderDashboard;
    private makeActiveSessionsLine;
    private makeMachineSessionCard;
    private makeModelCard;
    private makeMachineConnectedCard;
    private makeTipsCard;
    private renderStatusLine;
    private renderInfoBar;
}
export {};
