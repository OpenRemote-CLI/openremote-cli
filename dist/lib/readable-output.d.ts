import type { SessionReadableBlockIngest } from "./types.js";
interface DerivedReadableBlocksResult {
    blocks: SessionReadableBlockIngest[];
    remainder: string;
}
export declare function sanitizeTerminalText(text: string): string;
export declare function deriveReadableBlocksFromChunk(text: string, occurredAt: string, options?: {
    final?: boolean;
}): DerivedReadableBlocksResult;
export declare function makeReadableStatusBlock(status: string, occurredAt: string, body?: string): SessionReadableBlockIngest;
export declare function makeReadableErrorBlock(error: string, occurredAt: string): SessionReadableBlockIngest;
export declare function makeReadableApprovalBlock(message: string, occurredAt: string): SessionReadableBlockIngest;
export {};
