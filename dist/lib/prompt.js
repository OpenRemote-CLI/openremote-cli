import { createInterface } from "node:readline";
import chalk from "chalk";
function formatQuestion(question) {
    return `${chalk.cyan("?")} ${chalk.white(question.trim())} `;
}
/** Prompt for a text value. */
export function ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(formatQuestion(question), (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
/** Prompt for a secret (input masked with *). */
export function askSecret(question) {
    return new Promise((resolve) => {
        process.stdout.write(formatQuestion(question));
        const chars = [];
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        process.stdin.setEncoding("utf-8");
        const onData = (ch) => {
            if (ch === "\r" || ch === "\n") {
                cleanup();
                process.stdout.write("\n");
                resolve(chars.join(""));
            }
            else if (ch === "\u0003") {
                // Ctrl+C
                cleanup();
                process.stdout.write("\n");
                process.exit(130);
            }
            else if (ch === "\u007f" || ch === "\b") {
                if (chars.length > 0) {
                    chars.pop();
                    process.stdout.write("\b \b");
                }
            }
            else {
                chars.push(ch);
                process.stdout.write("*");
            }
        };
        const cleanup = () => {
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            process.stdin.pause();
            process.stdin.removeListener("data", onData);
        };
        process.stdin.on("data", onData);
    });
}
/** Yes / No confirmation (default No). */
export function confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`${formatQuestion(question)}${chalk.gray("(y/N)")} `, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y");
        });
    });
}
//# sourceMappingURL=prompt.js.map