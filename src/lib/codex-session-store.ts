import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

interface SessionIndexEntry {
  id: string;
  updated_at?: string;
}

interface SessionMetaPayload {
  id?: string;
  cwd?: string;
}

function normalizeDir(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function getCodexHome(): string {
  return path.join(homedir(), ".codex");
}

function getSessionIndexPath(): string {
  return path.join(getCodexHome(), "session_index.jsonl");
}

function findSessionFile(sessionId: string, updatedAt?: string): string | null {
  const sessionsRoot = path.join(getCodexHome(), "sessions");
  if (!existsSync(sessionsRoot)) {
    return null;
  }

  const datedRoots: string[] = [];
  if (updatedAt) {
    const date = new Date(updatedAt);
    if (!Number.isNaN(date.getTime())) {
      datedRoots.push(
        path.join(
          sessionsRoot,
          String(date.getUTCFullYear()),
          String(date.getUTCMonth() + 1).padStart(2, "0"),
          String(date.getUTCDate()).padStart(2, "0"),
        ),
      );
    }
  }
  datedRoots.push(sessionsRoot);

  for (const root of datedRoots) {
    if (!existsSync(root)) {
      continue;
    }

    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) {
          return fullPath;
        }
      }
    }
  }

  return null;
}

function readSessionMeta(filePath: string): SessionMetaPayload | null {
  try {
    const firstLine = readFileSync(filePath, "utf-8").split(/\r?\n/, 1)[0];
    if (!firstLine) {
      return null;
    }
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: SessionMetaPayload;
    };
    if (parsed.type !== "session_meta" || !parsed.payload) {
      return null;
    }
    return parsed.payload;
  } catch {
    return null;
  }
}

export function findCodexSessionIdForProject(projectPath: string, startedAtMs: number): string | null {
  const indexPath = getSessionIndexPath();
  if (!existsSync(indexPath)) {
    return null;
  }

  const normalizedProjectPath = normalizeDir(projectPath);
  const lines = readFileSync(indexPath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-30)
    .reverse();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SessionIndexEntry;
      if (!entry.id) {
        continue;
      }

      if (entry.updated_at) {
        const updatedAtMs = new Date(entry.updated_at).getTime();
        if (!Number.isNaN(updatedAtMs) && updatedAtMs + 5_000 < startedAtMs) {
          continue;
        }
      }

      const filePath = findSessionFile(entry.id, entry.updated_at);
      if (!filePath) {
        continue;
      }

      const meta = readSessionMeta(filePath);
      if (!meta?.cwd) {
        continue;
      }

      if (normalizeDir(meta.cwd) === normalizedProjectPath) {
        return entry.id;
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  return null;
}
