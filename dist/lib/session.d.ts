import { Bridge } from "./bridge.js";
import type { AgentProvider, AppConfig, InboundMessage } from "./types.js";
/**
 * Manages a single provider session at a time.
 * Receives commands from the bridge, delegates to the matching runner,
 * and streams results back through the bridge.
 */
export declare class SessionManager {
    private readonly bridge;
    private readonly apiKey;
    private readonly config?;
    private readonly runners;
    private readonly sessionProviders;
    private readonly sessionStatuses;
    private readonly sessionLogs;
    constructor(bridge: Bridge, apiKey: string, supportedProviders: AgentProvider[], config?: AppConfig | undefined);
    /**
     * Download attachments from signed URLs to a local temp directory.
     * Returns an array of local file paths.
     */
    private downloadAttachments;
    handleMessage(msg: InboundMessage): void;
    shutdown(): void;
    get busy(): boolean;
    private getActiveSessionCount;
    private updateActiveSessionCount;
    private handleStart;
    private handleCancel;
    private handleRespond;
    private handleInput;
    private handleFinish;
    private wireRunnerEvents;
    private getRunner;
    private getRunnerForSession;
    private finishProviderSession;
    private hasBusySessions;
    private failUnsupportedProvider;
}
