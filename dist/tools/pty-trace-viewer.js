import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
const tracePath = process.argv[2];
const sessionId = process.argv[3] ?? "unknown";
if (!tracePath) {
    process.stderr.write("Usage: node pty-trace-viewer.js <tracePath> [sessionId]\n");
    process.exit(1);
}
process.title = `OpenRemote PTY ${sessionId.slice(0, 8)}`;
let cursor = 0;
let remainder = "";
let endSeen = false;
function timeLabel(value) {
    if (typeof value !== "string") {
        return "--:--:--";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toISOString().slice(11, 19);
}
function writeMeta(label, detail) {
    const suffix = detail ? ` ${detail}` : "";
    process.stdout.write(`\r\n\x1b[90m[${label}]${suffix}\x1b[0m\r\n`);
}
function renderRecord(record) {
    const event = typeof record.event === "string" ? record.event : "unknown";
    const at = timeLabel(record.ts);
    if (event === "pty-output" && typeof record.data === "string") {
        process.stdout.write(record.data);
        return;
    }
    if (event === "pty-input") {
        const label = typeof record.label === "string" ? record.label : "input";
        const text = typeof record.text === "string" ? JSON.stringify(record.text) : "";
        const reason = typeof record.reason === "string" ? ` reason=${record.reason}` : "";
        const attempt = typeof record.attempt === "number" ? ` attempt=${record.attempt}` : "";
        writeMeta(`${at} ${label}`, `${text}${reason}${attempt}`);
        return;
    }
    if (event === "mode-detected" || event === "mode-banner") {
        const mode = typeof record.mode === "string" ? record.mode : "?";
        writeMeta(`${at} ${event}`, `mode=${mode}`);
        return;
    }
    if (event === "mode-handshake-failed") {
        writeMeta(`${at} ${event}`, typeof record.message === "string" ? record.message : "");
        return;
    }
    if (event === "trace-start") {
        writeMeta(`${at} session`, `trace=${tracePath}`);
        return;
    }
    if (event === "trace-end") {
        endSeen = true;
        writeMeta(`${at} session`, "trace ended");
        writeMeta("viewer", "session ended, window kept open for inspection");
        return;
    }
    writeMeta(`${at} ${event}`);
}
function pump() {
    if (!existsSync(tracePath)) {
        return;
    }
    const content = readFileSync(tracePath, "utf8");
    if (content.length < cursor) {
        cursor = 0;
        remainder = "";
    }
    const chunk = content.slice(cursor);
    if (!chunk) {
        return;
    }
    cursor = content.length;
    const combined = remainder + chunk;
    const lines = combined.split(/\r?\n/);
    remainder = lines.pop() ?? "";
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            renderRecord(JSON.parse(trimmed));
        }
        catch {
            writeMeta("parse-error", trimmed);
        }
    }
}
process.stdout.write(`OpenRemote PTY mirror for session ${sessionId}\r\n`);
process.stdout.write(`Trace file: ${tracePath}\r\n`);
process.stdout.write("Waiting for PTY events...\r\n");
const interval = setInterval(() => {
    pump();
    if (endSeen) {
        // Keep the window open for manual inspection.
    }
}, 120);
process.on("SIGINT", () => {
    clearInterval(interval);
    process.exit(0);
});
process.on("SIGTERM", () => {
    clearInterval(interval);
    process.exit(0);
});
//# sourceMappingURL=pty-trace-viewer.js.map