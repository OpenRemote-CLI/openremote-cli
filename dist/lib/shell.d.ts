export declare function getUnixShell(): string;
export declare function buildShellCommand(command: string, args: string[]): string;
export declare function getShellLaunch(): {
    shell: string;
    argsForCommand: (command: string) => string[];
};
export declare function resolveExecutable(command: string): string | null;
