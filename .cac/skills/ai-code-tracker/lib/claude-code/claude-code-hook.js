#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { git, gitRepoRoot } from "../tracker/git.js";
import { appendPendingLines } from "../tracker/lineStore.js";
import { snapshotDir } from "../tracker/paths.js";
import { logInfo, logError } from "../tracker/logger.js";
import { addedLines, loadConfig, shouldIgnore, safeRead } from "../tracker/shared.js";

const STALE_MS = 10 * 60 * 1000;

export async function runClaudeCodeHook(mode, options = {}) {
  const stdin = options.stdin ?? await readStdin();
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    return;
  }

  const toolName = input.tool_name;
  const toolUseId = input.tool_use_id;
  const cwd = input.cwd ?? process.cwd();
  const aiTool = options.aiTool ?? detectAiTool();

  if (!toolUseId) return;

  let repoRoot;
  try {
    repoRoot = await gitRepoRoot(toPosixPath(cwd));
  } catch {
    return;
  }

  const config = await loadConfig(repoRoot);
  if (!config.enabled) return;

  if (toolName === "Bash") {
    if (mode === "pre") {
      await handleBashPre({ repoRoot, toolUseId });
    } else if (mode === "post") {
      await handleBashPost({ repoRoot, toolUseId, config, aiTool });
    }
    return;
  }

  const filePath = input.tool_input?.file_path;
  if (!filePath) return;

  const absolutePath = path.resolve(toPosixPath(cwd), toPosixPath(filePath));
  const relative = await relativeToRepo(repoRoot, absolutePath);

  if (shouldIgnore(relative)) return;

  if (mode === "pre") {
    await handlePre({ repoRoot, absolutePath, relative, toolUseId });
  } else if (mode === "post") {
      await handlePost({ repoRoot, absolutePath, relative, toolUseId, config, aiTool });
  }
}

async function handlePre({ repoRoot, absolutePath, relative, toolUseId }) {
  try {
    await cleanStaleSnapshots(repoRoot);

    const dir = snapshotDir(repoRoot);
    await fs.mkdir(dir, { recursive: true });

    const before = await safeRead(absolutePath);
    const snapshot = { content: before, filePath: relative, timestamp: Date.now() };
    await fs.writeFile(path.join(dir, `${toolUseId}.json`), JSON.stringify(snapshot), "utf8");

    // Persist the original (first) snapshot for this file so re-edits diff from the true baseline
    const originalFile = path.join(dir, originalSnapshotName(relative));
    if (!await exists(originalFile)) {
      await fs.writeFile(originalFile, JSON.stringify(snapshot), "utf8");
    }

    await logInfo(repoRoot, "claude-code.pre", "captured snapshot", { file: relative });
  } catch (error) {
    await logError(repoRoot, "claude-code.pre", error.message, { file: relative });
  }
}

async function handlePost({ repoRoot, absolutePath, relative, toolUseId, config, aiTool }) {
  try {
    const dir = snapshotDir(repoRoot);
    const snapshotFile = path.join(dir, `${toolUseId}.json`);

    let snapshot;
    try {
      snapshot = JSON.parse(await fs.readFile(snapshotFile, "utf8"));
    } catch {
      return;
    }

    // Prefer the original (first) snapshot so repeated edits diff from the true baseline
    const originalFile = path.join(dir, originalSnapshotName(relative));
    let original;
    try {
      original = JSON.parse(await fs.readFile(originalFile, "utf8"));
    } catch {
      original = snapshot;
    }

    const isNewFile = original.content === undefined || original.content === null || original.content === "";
    const after = await safeRead(absolutePath);
    const added = isNewFile ? String(after).split(/\r?\n/) : addedLines(original.content, after);

    if (added.length > 0) {
      await appendPendingLines(repoRoot, relative, added, {
        countBlankLines: config.countBlankLines,
        dedupeExisting: true,
        replace: true,
        aiTool,
      });
    } else {
      await appendPendingLines(repoRoot, relative, [], { replace: true });
    }

    await fs.rm(snapshotFile, { force: true });
    // Keep original snapshot alive for potential further edits (stale cleanup will remove it)
    await logInfo(repoRoot, "claude-code.post", "recorded added lines", { file: relative, addedLines: added.length });
  } catch (error) {
    await logError(repoRoot, "claude-code.post", error.message, { file: relative });
  }
}

async function handleBashPre({ repoRoot, toolUseId }) {
  try {
    await cleanStaleSnapshots(repoRoot);

    const state = await captureGitFileHashes(repoRoot);
    const dir = snapshotDir(repoRoot);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `bash-${toolUseId}.json`), JSON.stringify(state), "utf8");

    await logInfo(repoRoot, "claude-code.bash-pre", "captured file hashes", { files: Object.keys(state).length });
  } catch (error) {
    await logError(repoRoot, "claude-code.bash-pre", error.message);
  }
}

async function handleBashPost({ repoRoot, toolUseId, config, aiTool }) {
  try {
    const dir = snapshotDir(repoRoot);
    const snapshotFile = path.join(dir, `bash-${toolUseId}.json`);

    let prevHashes;
    try {
      prevHashes = JSON.parse(await fs.readFile(snapshotFile, "utf8"));
    } catch {
      return;
    }

    const currentHashes = await captureGitFileHashes(repoRoot);
    const { loadPendingLines } = await import("../tracker/lineStore.js");
    const pending = await loadPendingLines(repoRoot);
    let trackedCount = 0;

    for (const [file, hash] of Object.entries(currentHashes)) {
      if (shouldIgnore(file)) continue;
      if (prevHashes[file] === hash) continue;

      const absolutePath = path.join(repoRoot, file);
      const content = await safeRead(absolutePath);
      const lines = content.split(/\r?\n/).filter((l) => config.countBlankLines || l.trim() !== "");
      if (lines.length > 0) {
        await appendPendingLines(repoRoot, file, lines, { countBlankLines: config.countBlankLines, dedupeExisting: true, replace: true, aiTool });
        trackedCount++;
      }
    }

    await fs.rm(snapshotFile, { force: true });
    await logInfo(repoRoot, "claude-code.bash-post", "processed", { trackedFiles: trackedCount });
  } catch (error) {
    await logError(repoRoot, "claude-code.bash-post", error.message);
  }
}

async function captureGitFileHashes(repoRoot) {
  const [modifiedRaw, stagedRaw, untrackedRaw] = await Promise.all([
    git(["diff", "--name-only"], { cwd: repoRoot }).catch(() => ""),
    git(["diff", "--cached", "--name-only"], { cwd: repoRoot }).catch(() => ""),
    git(["ls-files", "--others", "--exclude-standard"], { cwd: repoRoot }).catch(() => ""),
  ]);
  const files = [...new Set([
    ...modifiedRaw.split("\n").filter(Boolean),
    ...stagedRaw.split("\n").filter(Boolean),
    ...untrackedRaw.split("\n").filter(Boolean),
  ])];

  const hashes = {};
  await Promise.all(files.map(async (file) => {
    try {
      const content = await fs.readFile(path.join(repoRoot, file));
      const { createHash } = await import("node:crypto");
      hashes[file] = createHash("md5").update(content).digest("hex");
    } catch {
      hashes[file] = "";
    }
  }));
  return hashes;
}

async function cleanStaleSnapshots(repoRoot) {
  const dir = snapshotDir(repoRoot);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }

  const cutoff = Date.now() - STALE_MS;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const stat = await fs.stat(path.join(dir, entry));
      if (stat.mtimeMs < cutoff) await fs.rm(path.join(dir, entry), { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

function toPosixPath(p) {
  return String(p).replaceAll("\\", "/");
}

function originalSnapshotName(relative) {
  return `original-${relative.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

function detectAiTool() {
  return process.argv[1]?.includes(`${path.sep}.cac${path.sep}`) ? "codeagent-cli" : "claude-code";
}

async function relativeToRepo(repoRoot, absolutePath) {
  const [canonicalRoot, canonicalPath] = await Promise.all([
    canonicalizePath(repoRoot),
    canonicalizePath(absolutePath),
  ]);
  return path.relative(canonicalRoot, canonicalPath).replaceAll(path.sep, "/");
}

async function canonicalizePath(filePath) {
  try {
    return await fs.realpath(filePath);
  } catch {
    const parent = path.dirname(filePath);
    if (parent === filePath) { return path.resolve(filePath); }
    return path.join(await canonicalizePath(parent), path.basename(filePath));
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runClaudeCodeHook(process.argv[2]).catch(() => {
    // Never block Claude Code.
  });
}
