import type {
  SessionReadableBlockIngest,
  SessionReadableBlockKind,
} from "./types.js";

interface ClassifiedLine {
  kind: SessionReadableBlockKind;
  title?: string;
  body: string;
}

interface DerivedReadableBlocksResult {
  blocks: SessionReadableBlockIngest[];
  remainder: string;
}

const INLINE_BULLET_SEPARATOR = /\s+[\u2022\u00b7]\s+/g;
const INLINE_COMMAND_START =
  /\s+(?=(?:Running|Ran|Run)\s+(?:\$[A-Za-z_]\w*\s*=|PS\s|[A-Za-z]:\\|rg\b|fd\b|grep\b|git\b|npm\b|npx\b|pnpm\b|yarn\b|node\b|python\b|pip\b|uv\b|cargo\b|go\b|deno\b|docker\b|powershell\b|cmd\b|Get-|Set-|New-|Remove-|Move-|Copy-|Select-String|Select-Object|Get-Content|Test-Path|Set-Content|Add-Content))/i;
const INLINE_PATH_REGEX =
  /(?:[A-Za-z]:\\[^\s"'<>|?*]+(?:\\[^\s"'<>|?*]+)*|(?:\.{0,2}[\\/])?[A-Za-z0-9_.@()-]+(?:[\\/][A-Za-z0-9_.@() -]+)+)/g;

function stripAnsiAndControl(text: string): string {
  return normalizeCarriageReturns(text)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\u001b/g, "");
}

function normalizeCarriageReturns(text: string): string {
  const lines: string[] = [];
  let current = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "\r") {
      if (text[index + 1] === "\n") {
        lines.push(current);
        current = "";
        index += 1;
      } else {
        current = "";
      }
      continue;
    }

    if (char === "\n") {
      lines.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines.join("\n");
}

function normalizeTerminalStream(text: string): string {
  return repairMojibake(
    stripAnsiAndControl(text)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n"),
  );
}

function repairMojibake(text: string): string {
  return text
    .replace(/\u00e2\u20ac\u2122/g, "\u2019")
    .replace(/\u00e2\u20ac\u02dc/g, "\u2018")
    .replace(/\u00e2\u20ac\u0153/g, "\u201c")
    .replace(/\u00e2\u20ac\u201d/g, "\u2014")
    .replace(/\u00e2\u20ac\u201c/g, "\u2013")
    .replace(/\u00e2\u20ac\u00a6/g, "\u2026")
    .replace(/\u00c3\u00a9/g, "\u00e9")
    .replace(/\u00c3\u00a8/g, "\u00e8")
    .replace(/\u00c3\u00aa/g, "\u00ea")
    .replace(/\u00c3\u00a2/g, "\u00e2")
    .replace(/\u00c3\u00ae/g, "\u00ee")
    .replace(/\u00c3\u00b4/g, "\u00f4")
    .replace(/\u00c3\u00b9/g, "\u00f9")
    .replace(/\u00c3\u00bb/g, "\u00fb")
    .replace(/\u00c3\u00a7/g, "\u00e7")
    .replace(/\u00c3\u00ab/g, "\u00eb")
    .replace(/\u00c5\u201c/g, "\u0153");
}

export function sanitizeTerminalText(text: string): string {
  return normalizeTerminalStream(text).trim();
}

function normalizeForDedup(kind: string, body: string): string {
  let n = body.toLowerCase().replace(/\s+/g, " ").trim();
  if (kind === "command") {
    n = n.replace(/^(ran|running|run)\s+/i, "");
    n = n.replace(/^[\$>\s]+/, "");
  }
  return n;
}

function normalizeReadableText(body: string): string {
  return body
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
}

function isTextContinuation(previousBody: string, nextBody: string): boolean {
  const previous = normalizeReadableText(previousBody);
  const next = normalizeReadableText(nextBody);
  if (!previous || !next) {
    return false;
  }

  return previous === next || next.startsWith(previous) || previous.startsWith(next);
}

function normalizeTransientProgressText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\([^)]*\d+\s*s[^)]*\)/gi, " ")
    .replace(/\b\d+\s*s\b/gi, " ")
    .replace(/[\u2026.]{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isTransientProgressText(text: string): boolean {
  const normalized = collapseWhitespace(stripBulletPrefix(text));
  if (!normalized) {
    return false;
  }

  if (
    isCommandLine(normalized) ||
    isErrorLine(normalized) ||
    isPathLine(normalized) ||
    isCodeBlockLine(normalized)
  ) {
    return false;
  }

  const base = normalizeTransientProgressText(normalized);
  if (base.length < 12) {
    return false;
  }

  return (
    /\([^)]*\d+\s*s[^)]*\)/i.test(normalized) ||
    /\b\d+\s*s\b/i.test(normalized) ||
    /\u2026|\.{3}/.test(normalized) ||
    /^(just a moment|finding|searching|looking|checking|reading|opening|locating|reviewing|analyzing|analysing|updating|loading|preparing|scanning|inspecting|exploring|i need to|i'm|i am)/i.test(
      normalized,
    )
  );
}

function sameTransientProgressText(left: string, right: string): boolean {
  const normalizedLeft = normalizeTransientProgressText(left);
  const normalizedRight = normalizeTransientProgressText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(normalizedRight) ||
    normalizedRight.startsWith(normalizedLeft)
  );
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function stripBulletPrefix(text: string): string {
  return text.replace(/^\s*(?:[>*-]|\d+\.)\s+/, "").trim();
}

function isBoxDrawingLine(text: string): boolean {
  if (/[\u2500-\u257F\u2580-\u259F]/u.test(text)) {
    return true;
  }

  const stripped = text.replace(/[\s|_`~:;.,=*+\-()[\]\\/]/g, "");
  return stripped.length === 0;
}

function isTerminalChromeLine(text: string): boolean {
  const lower = text.toLowerCase();

  return (
    lower.includes("@filename") ||
    lower.startsWith("tip:") ||
    lower.includes("openai codex") ||
    lower.includes("tip: new try the codex app") ||
    lower.includes("chatgpt.com/codex") ||
    lower.includes("auto-accept edits") ||
    lower.includes("tab to cycle") ||
    lower.includes("model to change") ||
    lower.startsWith("model:") ||
    lower.startsWith("directory:") ||
    lower.includes("% left") ||
    /\bgpt-[\w.-]+\b/.test(lower) ||
    /^ran \d+ commands?$/i.test(text) ||
    /^shell$/i.test(text)
  );
}

function isBrokenResidueLine(text: string): boolean {
  const normalized = text.trim();
  const letters = countMatches(normalized, /\p{L}/gu);
  const digits = countMatches(normalized, /\d/g);
  const symbols = countMatches(normalized, /[^\p{L}\d\s]/gu);

  if (/^(?:0;|;\)|;\]|\]\d*;)/.test(normalized)) {
    return true;
  }

  if (/^[\p{L}\d._:-]+$/u.test(normalized)) {
    return false;
  }

  if (letters <= 2 && digits + symbols >= 3) {
    return true;
  }

  if (!normalized.includes(" ") && letters < 5 && normalized.length < 14) {
    return true;
  }

  return false;
}

function isCommandLine(text: string): boolean {
  const normalized = stripBulletPrefix(text);
  const strippedAction = normalized.replace(/^(?:running|ran|run)\s+/i, "").trim();

  const looksShellLike = (value: string): boolean => {
    if (/^\$\s+\S/.test(value)) return true;
    if (/^\$[A-Za-z_]\w*\s*=\s*(Get-|Set-|New-|Remove-|Move-|Copy-|Select-String|Select-Object|Get-Content|Test-Path|Set-Content|Add-Content)\S*/i.test(value)) {
      return true;
    }
    if (/^PS\s[^>]+>\s+\S/i.test(value)) return true;
    if (/^[A-Za-z]:\\[^>]*>\s+\S/.test(value)) return true;
    if (/^(npm|npx|pnpm|yarn|git|node|python|pip|uv|cargo|go|deno|docker|rg|fd|grep|sed|awk|cat|ls|dir|findstr|find|powershell|cmd)\s+[\w\-./\\'"]/i.test(value)) {
      return true;
    }
    if (/^(Get-|Set-|New-|Remove-|Move-|Copy-|Select-String|Select-Object|Get-Content|Test-Path|Set-Content|Add-Content)\S*/i.test(value)) {
      return true;
    }
    return false;
  };

  return looksShellLike(normalized) || looksShellLike(strippedAction);
}

function isErrorLine(text: string): boolean {
  return /\b(error|erreur|failed|failure|traceback|enoent|eacces|exception|incorrect function|os error)\b/i.test(
    text,
  );
}

function isThinkingMarker(text: string): boolean {
  const normalized = stripBulletPrefix(text);
  const lower = normalized.toLowerCase();

  return (
    lower === "thinking" ||
    lower.startsWith("working (") ||
    lower.includes("esc to interrupt") ||
    lower.includes("use /skills") ||
    lower.startsWith("processing") ||
    lower.startsWith("analyzing") ||
    lower.startsWith("analysing") ||
    lower.startsWith("thinking...")
  );
}

function isHumanReadableLine(text: string): boolean {
  const normalized = stripBulletPrefix(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  const letters = countMatches(normalized, /\p{L}/gu);

  if (words.length >= 6 && letters >= 20) {
    return true;
  }

  if (words.length >= 4 && letters >= 12) {
    return true;
  }

  if (/[.!?]$/.test(normalized) && words.length >= 4 && letters >= 14) {
    return true;
  }

  return false;
}

function isPathLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 220) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 4) return false;
  if (/^[A-Za-z]:\\[\w\\.\-()[\] ]+$/.test(trimmed)) return true;
  if (/^\.{0,2}[\\/][\w/\\.\-()[\]@ ]+$/.test(trimmed)) return true;
  if (/^[\w.\-/\\()[\]@]+\.\w{1,5}$/.test(trimmed) && /[/\\]/.test(trimmed)) return true;
  if (/^[\w.\-/\\()[\]@]+[\\/]$/.test(trimmed)) return true;
  return false;
}

function isCodeBlockLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^\d+[+-]/.test(trimmed)) return true;
  if (/^[+-]\s*(import|export|const|let|var|function|class|interface|return)\b/.test(trimmed)) {
    return true;
  }

  let signals = 0;
  if (/[{]\s*$/.test(trimmed) || /^\s*[}]/.test(trimmed)) signals += 1;
  if (/;\s*$/.test(trimmed)) signals += 1;
  if (/^\s*(import|export)\s+.+\s+from\s+['"]/.test(trimmed)) signals += 2;
  if (/^\s*(const|let|var)\s+\w+\s*[:=]/.test(trimmed)) signals += 2;
  if (/^\s*function\s+\w+\s*\(/.test(trimmed)) signals += 2;
  if (/^\s*(class|interface)\s+\w+/.test(trimmed) && /[{]/.test(trimmed)) signals += 2;
  if (/^\s*return\s+[^;]+;?\s*$/.test(trimmed)) signals += 1;
  if (/=>\s*[{(]/.test(trimmed)) signals += 1;
  if (
    /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\s+/i.test(trimmed) &&
    /\b(FROM|INTO|SET|TABLE|VALUES|WHERE)\b/i.test(trimmed)
  ) {
    signals += 2;
  }

  return signals >= 2;
}

function splitAroundInlineCommand(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const match = INLINE_COMMAND_START.exec(trimmed);
  INLINE_COMMAND_START.lastIndex = 0;
  if (!match || typeof match.index !== "number") {
    return [trimmed];
  }

  const left = trimmed.slice(0, match.index).trim();
  const right = trimmed.slice(match.index).trim();
  return [left, right].filter(Boolean);
}

function splitAroundInlinePaths(text: string): string[] {
  const trimmed = text.trim();
  if (
    !trimmed ||
    isCommandLine(trimmed) ||
    isCodeBlockLine(trimmed) ||
    isPathLine(trimmed) ||
    isErrorLine(trimmed) ||
    isThinkingMarker(trimmed)
  ) {
    return trimmed ? [trimmed] : [];
  }

  const matches = [...trimmed.matchAll(INLINE_PATH_REGEX)];
  if (matches.length === 0) {
    return [trimmed];
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (typeof match.index !== "number") {
      continue;
    }

    const value = match[0];
    const start = match.index;
    const end = start + value.length;

    const before = trimmed.slice(cursor, start).trim();
    if (before) {
      parts.push(before);
    }

    parts.push(value.trim());
    cursor = end;
  }

  const after = trimmed.slice(cursor).trim();
  if (after) {
    parts.push(after);
  }

  return parts.filter(Boolean);
}

function splitLineIntoSegments(text: string): string[] {
  const normalized = collapseWhitespace(text);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(INLINE_BULLET_SEPARATOR)
    .flatMap((part) => splitAroundInlineCommand(part))
    .flatMap((part) => splitAroundInlinePaths(part))
    .map((part) => part.trim())
    .filter(Boolean);
}

function classifySegment(text: string): ClassifiedLine | null {
  const content = stripBulletPrefix(text);

  if (!content) {
    return null;
  }

  if (
    isBoxDrawingLine(content) ||
    isTerminalChromeLine(content) ||
    isBrokenResidueLine(content)
  ) {
    return null;
  }

  if (isThinkingMarker(content)) {
    return {
      kind: "thinking",
      title: "Thinking",
      body: "Thinking",
    };
  }

  if (isCommandLine(content)) {
    return {
      kind: "command",
      title: "Command",
      body: content.replace(/^(?:running|ran|run)\s+/i, ""),
    };
  }

  if (isErrorLine(content)) {
    return {
      kind: "error",
      title: "Error",
      body: content,
    };
  }

  if (isPathLine(content)) {
    return {
      kind: "path",
      title: "Path",
      body: content,
    };
  }

  if (isCodeBlockLine(content)) {
    return {
      kind: "code",
      title: "Code",
      body: content,
    };
  }

  if (!isHumanReadableLine(content)) {
    return null;
  }

  return {
    kind: "text",
    body: content,
  };
}

function appendGroupedBlock(grouped: ClassifiedLine[], candidate: ClassifiedLine): void {
  const previous = grouped.at(-1);

  if (candidate.kind === "thinking") {
    if (previous?.kind === "thinking") {
      return;
    }
    grouped.push({ ...candidate });
    return;
  }

  if (
    previous &&
    previous.kind === candidate.kind &&
    previous.body !== candidate.body &&
    previous.body.length + candidate.body.length < 1200
  ) {
    if (
      candidate.kind === "text" &&
      !isTransientProgressText(previous.body) &&
      !isTransientProgressText(candidate.body) &&
      isTextContinuation(previous.body, candidate.body)
    ) {
      if (candidate.body.length >= previous.body.length) {
        previous.body = candidate.body;
      }
      return;
    }

    if (
      candidate.kind === "text" &&
      isTransientProgressText(previous.body) &&
      isTransientProgressText(candidate.body) &&
      sameTransientProgressText(previous.body, candidate.body)
    ) {
      if (candidate.body.length >= previous.body.length) {
        previous.body = candidate.body;
      }
      return;
    }

    const previousNormalized = normalizeForDedup(previous.kind, previous.body);
    const candidateNormalized = normalizeForDedup(candidate.kind, candidate.body);

    if (
      candidateNormalized.startsWith(previousNormalized) ||
      previousNormalized.startsWith(candidateNormalized)
    ) {
      if (candidate.body.length >= previous.body.length) {
        previous.body = candidate.body;
      }
      return;
    }

    const joiner = candidate.kind === "command" ? "\n" : "\n\n";
    if (
      candidate.kind === "text" &&
      (isTransientProgressText(previous.body) || isTransientProgressText(candidate.body))
    ) {
      grouped.push({ ...candidate });
      return;
    }
    previous.body = `${previous.body}${joiner}${candidate.body}`;
    return;
  }

  if (
    previous &&
    previous.kind === candidate.kind &&
    normalizeForDedup(previous.kind, previous.body) === normalizeForDedup(candidate.kind, candidate.body)
  ) {
    return;
  }

  grouped.push({ ...candidate });
}

export function deriveReadableBlocksFromChunk(
  text: string,
  occurredAt: string,
  options?: { final?: boolean },
): DerivedReadableBlocksResult {
  const normalized = normalizeTerminalStream(text);
  if (!normalized.trim()) {
    return {
      blocks: [],
      remainder: "",
    };
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line) => line.trim().length > 0);

  let remainder = "";
  if (!options?.final && lines.length > 0 && !/\n\s*$/.test(normalized)) {
    remainder = lines.pop() ?? "";
  }

  const grouped: ClassifiedLine[] = [];
  for (const line of lines) {
    const segments = splitLineIntoSegments(line);
    for (const segment of segments) {
      const classified = classifySegment(segment);
      if (!classified) {
        continue;
      }
      appendGroupedBlock(grouped, classified);
    }
  }

  return {
    blocks: grouped.map((block) => ({
      kind: block.kind,
      title: block.title,
      body: block.body.trim(),
      occurredAt,
    })),
    remainder,
  };
}

export function makeReadableStatusBlock(
  status: string,
  occurredAt: string,
  body?: string,
): SessionReadableBlockIngest {
  return {
    kind: status === "failed" || status === "cancelled" ? "error" : "status",
    title: "Status",
    body: body ? `${status} - ${body}` : status,
    occurredAt,
  };
}

export function makeReadableErrorBlock(
  error: string,
  occurredAt: string,
): SessionReadableBlockIngest {
  return {
    kind: "error",
    title: "Error",
    body: sanitizeTerminalText(error) || error,
    occurredAt,
  };
}

export function makeReadableApprovalBlock(
  message: string,
  occurredAt: string,
): SessionReadableBlockIngest {
  return {
    kind: "status",
    title: "Approval",
    body: sanitizeTerminalText(message) || message,
    occurredAt,
  };
}
