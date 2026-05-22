import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const INVISIBLE_CHARS = /[\u200B-\u200D\uFEFF]/g;

export type ProjectPathResolution =
  | { ok: true; path: string; input: string; candidates: string[] }
  | { ok: false; input: string; candidates: string[] };

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
    return value.slice(1, -1);
  }

  return value;
}

function rootLength(value: string): number {
  if (/^[A-Za-z]:[\\/]$/.test(value)) return 3;
  if (/^[A-Za-z]:$/.test(value)) return 2;

  const uncMatch = value.match(/^([\\/]{2}[^\\/]+[\\/][^\\/]+)/);
  if (uncMatch) return uncMatch[1].length;

  if (/^[\\/]/.test(value)) return 1;
  return 0;
}

export function stripTrailingPathSeparators(value: string): string {
  const minLength = rootLength(value);
  let end = value.length;

  while (end > minLength && /[\\/]/.test(value[end - 1])) {
    end -= 1;
  }

  return value.slice(0, end);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return `${homedir()}${value.slice(1)}`;
  }

  return value;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function splitPath(value: string): { parent: string; name: string; separator: string } | null {
  const slash = value.lastIndexOf("/");
  const backslash = value.lastIndexOf("\\");
  const index = Math.max(slash, backslash);
  if (index < 0) return null;

  const separator = slash > backslash ? "/" : "\\";
  const parent = index === 0 ? separator : value.slice(0, index);
  const name = value.slice(index + 1);
  if (!parent || !name) return null;

  return { parent, name, separator };
}

function joinPath(parent: string, name: string, separator: string): string {
  if (parent.endsWith("/") || parent.endsWith("\\")) {
    return `${parent}${name}`;
  }

  return `${parent}${separator}${name}`;
}

function resolveTrailingWhitespacePath(value: string): string | null {
  const split = splitPath(value);
  if (!split || !existsSync(split.parent)) return null;

  let entries: string[];
  try {
    entries = readdirSync(split.parent);
  } catch {
    return null;
  }

  const requested = split.name.trimEnd();
  const matches = entries.filter(
    (entry) => entry !== split.name && entry.trimEnd() === requested,
  );

  if (matches.length !== 1) return null;

  const resolved = joinPath(split.parent, matches[0], split.separator);
  return existsSync(resolved) ? resolved : null;
}

export function normalizeProjectPathInput(value: string): string {
  const unquoted = stripMatchingQuotes(value.trim().replace(INVISIBLE_CHARS, "")).trim();
  return stripTrailingPathSeparators(unquoted);
}

export function resolveExistingProjectPath(value: string): ProjectPathResolution {
  const cleaned = stripMatchingQuotes(value.trim().replace(INVISIBLE_CHARS, "")).trim();
  const normalized = stripTrailingPathSeparators(cleaned);
  const candidates = unique([
    cleaned,
    normalized,
    expandHome(cleaned),
    expandHome(normalized),
  ]);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { ok: true, path: candidate, input: cleaned, candidates };
    }

    const whitespaceResolved = resolveTrailingWhitespacePath(candidate);
    if (whitespaceResolved) {
      return {
        ok: true,
        path: whitespaceResolved,
        input: cleaned,
        candidates: unique([...candidates, whitespaceResolved]),
      };
    }
  }

  return { ok: false, input: normalized || cleaned, candidates };
}
