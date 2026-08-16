import fs from "node:fs/promises";
import { lockPath, pendingLinesPath } from "./paths.js";
import { atomicWriteJson, withFileLock } from "./lock.js";

export async function loadPendingLines(repoRoot) {
  const file = pendingLinesPath(repoRoot);
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    return migrateStore(raw);
  } catch (error) {
    if (error.code === "ENOENT") { return {}; }
    throw error;
  }
}

export async function savePendingLines(repoRoot, data) {
  await atomicWriteJson(pendingLinesPath(repoRoot), normalizeStore(data), {
    operation: "write pending AI lines",
  });
}

export async function appendPendingLines(repoRoot, filePath, lines, options = {}) {
  const countBlankLines = options.countBlankLines ?? false;
  const dedupeExisting = options.dedupeExisting ?? false;
  const replace = options.replace ?? false;
  const aiTool = options.aiTool ?? null;
  return withFileLock(lockPath(repoRoot, "pending-lines"), async () => {
    const pending = await loadPendingLines(repoRoot);
    const base = replace ? [] : (pending[filePath] ?? []);
    const firstTool = pending[filePath]?.find((entry) => entry.ai_tool)?.ai_tool ?? aiTool;
    const existing = new Set(base.map((e) => e.content));
    const additions = [];
    for (const line of lines) {
      if (!countBlankLines && line.trim() === "") { continue; }
      if (dedupeExisting && existing.has(line)) { continue; }
      additions.push({
        content: line,
        ...(firstTool ? { ai_tool: firstTool } : {}),
        consumed: false,
      });
    }
    if (replace && additions.length > 0) {
      pending[filePath] = additions;
    } else if (additions.length > 0) {
      pending[filePath] = [...base, ...additions];
    }
    if (replace && additions.length === 0 && pending[filePath]) {
      delete pending[filePath];
    }
    await savePendingLines(repoRoot, pending);
    return pending;
  }, { operation: "record pending AI lines" });
}

export function consumeMatchedLines(pending, matched) {
  const next = normalizeStore(pending);

  for (const [filePath, lines] of Object.entries(matched ?? {})) {
    const entries = next[filePath] ?? [];
    const matchPool = [...lines];
    for (const entry of entries) {
      if (entry.consumed) { continue; }
      const index = matchPool.indexOf(entry.content);
      if (index === -1) { continue; }
      entry.consumed = true;
      matchPool.splice(index, 1);
    }
  }

  return next;
}

function normalizeStore(data) {
  const out = {};
  for (const [filePath, entries] of Object.entries(data ?? {})) {
    if (!Array.isArray(entries) || entries.length === 0) { continue; }
    const cleaned = entries.filter(isValidEntry);
    if (cleaned.length > 0) { out[filePath] = cleaned; }
  }
  return out;
}

function isValidEntry(entry) {
  return entry && typeof entry.content === "string";
}

function migrateStore(data) {
  const out = {};
  for (const [filePath, entries] of Object.entries(data ?? {})) {
    if (!Array.isArray(entries) || entries.length === 0) { continue; }
    out[filePath] = entries.map((entry) =>
      typeof entry === "string" ? { content: entry, consumed: false } : entry,
    );
  }
  return out;
}
