import type { AppConfig } from "./types.js";
export declare function getConfigDir(): string;
export declare function getConfigPath(): string;
export declare function ensureConfigDir(): string;
export declare function configExists(): boolean;
export declare function loadConfig(): AppConfig | null;
export declare function saveConfig(config: AppConfig): void;
export declare function updateConfig(partial: Partial<AppConfig>): AppConfig | null;
