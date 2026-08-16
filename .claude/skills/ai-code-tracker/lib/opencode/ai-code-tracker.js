import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { git, gitRepoRoot } from "../tracker/git.js";
import { appendPendingLines, loadPendingLines } from "../tracker/lineStore.js";
import { logInfo, startTimer } from "../tracker/logger.js";
import { addedLines, loadConfig, shouldIgnore, safeRead } from "../tracker/shared.js";
import { checkVersion } from "../tracker/updater.js";

const beforeSnapshots = new Map();
const originalSnapshots = new Map();
const pendingFileEditedTimers = new Map();
const BASH_FALLBACK_MS = 30000;

let bashBaselineHashes = null;
let bashBaselineRepoRoot = null;
let bashFallbackTimer = null;

export async function recordEditedFile({ cwd = process.cwd(), filePath, before, after = "", replace = false, aiTool = "opencode" }) {
  const timer = startTimer();
  const repoRoot = await gitRepoRoot(cwd);
  const relative = await relativeToRepo(repoRoot, path.resolve(cwd, filePath));

  const config = await loadConfig(repoRoot);
  if (!config.enabled) {
    await logInfo(repoRoot, "recordEditedFile", "skipped: disabled", { file: relative });
    return { skipped: "disabled" };
  }

  if (shouldIgnore(relative)) {
    await logInfo(repoRoot, "recordEditedFile", "skipped: ignored", { file: relative });
    return { skipped: "ignored" };
  }
  const isNewFile = before === undefined || before === null || before === "";
  const added = isNewFile ? String(after).split(/\r?\n/) : addedLines(before, after);
  await appendPendingLines(repoRoot, relative, added, {
    countBlankLines: config.countBlankLines,
    dedupeExisting: true,
    replace,
    aiTool,
  });
  await logInfo(repoRoot, "recordEditedFile", "recorded added lines", { file: relative, addedLines: added.length, newFile: isNewFile, durationMs: timer.elapsedMs() });
  return { recorded: added.length };
}

export const AiCodeTrackerPlugin = async ({ directory, worktree, client } = {}) => {
  const cwd = worktree ?? directory ?? process.cwd();

  let repoRootForLog;
  try {
    repoRootForLog = await gitRepoRoot(cwd);
  } catch {
    repoRootForLog = null;
  }

  await log(client, "info", "ai-code-tracker plugin initialized", { cwd });
  if (repoRootForLog) await logInfo(repoRootForLog, "plugin.init", "ai-code-tracker plugin initialized", { cwd });

  // Async version check — don't block initialization
  if (repoRootForLog) {
    checkVersion(repoRootForLog).then((update) => {
      if (update) {
        log(client, "warn", `ai-code-tracker 升级可用: ${update.local_version} → ${update.remote_version}，运行 /ai-update 升级`);
      }
    }).catch(() => {});
  }

  return {
    event: async ({ event }) => {
      if (event?.type !== "file.edited") return;
      const payload = event.properties ?? event;
      const filePath = payload.path ?? payload.file ?? payload.filePath;
      if (!filePath) return;

      const eventCwd = payload.cwd ?? cwd;
      if (repoRootForLog) await logInfo(repoRootForLog, "event.file-edited", "enter", { file: filePath });

      const key = snapshotKey(eventCwd, filePath);
      clearPendingFileEdited(key);
      pendingFileEditedTimers.set(key, setTimeout(async () => {
        pendingFileEditedTimers.delete(key);
        if (!beforeSnapshots.has(key)) return;
        await recordEditedFile({
          cwd: eventCwd,
          filePath,
          before: payload.before ?? payload.old ?? beforeSnapshots.get(key),
          after: await safeRead(path.resolve(eventCwd, filePath)),
          aiTool: "opencode",
        });
        beforeSnapshots.delete(key);
      }, 250));
    },

    "tool.execute.before": async (input, output) => {
      const tool = input?.tool ?? output?.tool;
      const toolName = String(tool ?? "").toLowerCase();
      const args = output?.args ?? input?.args ?? {};

      if (toolName.includes("bash")) {
        await handleBashBefore({ cwd, tool, args });
        return;
      }

      const filePath = extractFilePath(tool, args);
      if (!filePath) return;

      if (repoRootForLog) await logInfo(repoRootForLog, "tool.execute.before", "capturing snapshot", { tool: String(tool), file: filePath });
      const key = snapshotKey(cwd, filePath);
      const content = await safeRead(path.resolve(cwd, filePath));
      beforeSnapshots.set(key, content);
      if (!originalSnapshots.has(key)) originalSnapshots.set(key, content);
    },

    "tool.execute.after": async (input, output) => {
      const tool = input?.tool ?? output?.tool;
      const toolName = String(tool ?? "").toLowerCase();
      const args = output?.args ?? input?.args ?? {};

      if (toolName.includes("bash")) {
        await handleBashAfter({ cwd, tool, args });
        return;
      }

      const filePath = extractFilePath(tool, args);
      if (!filePath) return;

      if (repoRootForLog) await logInfo(repoRootForLog, "tool.execute.after", "processing edit", { tool: String(tool), file: filePath });

      const key = snapshotKey(cwd, filePath);
      clearPendingFileEdited(key);
      const before = originalSnapshots.get(key) ?? beforeSnapshots.get(key);
      beforeSnapshots.delete(key);

      await recordEditedFile({
        cwd,
        filePath,
        before,
        after: await safeRead(path.resolve(cwd, filePath)),
        replace: true,
        aiTool: "opencode",
      });
    },
  };
};

export default AiCodeTrackerPlugin;

async function handleBashBefore({ cwd, tool, args }) {
  try {
    const repoRoot = await gitRepoRoot(cwd);
    const currentHashes = await captureGitFileHashes(repoRoot);

    if (bashBaselineHashes && bashBaselineRepoRoot === repoRoot) {
      await recordBashChanges(bashBaselineHashes, currentHashes, repoRoot);
      bashBaselineHashes = null;
    }

    bashBaselineHashes = currentHashes;
    bashBaselineRepoRoot = repoRoot;

    if (bashFallbackTimer) clearTimeout(bashFallbackTimer);
    bashFallbackTimer = setTimeout(async () => {
      bashFallbackTimer = null;
      if (!bashBaselineHashes || bashBaselineRepoRoot !== repoRoot) return;
      try {
        const afterHashes = await captureGitFileHashes(bashBaselineRepoRoot);
        await recordBashChanges(bashBaselineHashes, afterHashes, bashBaselineRepoRoot);
      } catch {}
    }, BASH_FALLBACK_MS);

    await logInfo(repoRoot, "tool.execute.before", "captured bash file hashes", { files: Object.keys(currentHashes).length });
  } catch (error) {
    await logInfo(cwd, "tool.execute.before", `bash-pre error: ${error.message}`);
  }
}

async function handleBashAfter({ cwd, tool, args }) {
  if (bashFallbackTimer) {
    clearTimeout(bashFallbackTimer);
    bashFallbackTimer = null;
  }

  try {
    const repoRoot = bashBaselineRepoRoot ?? await gitRepoRoot(cwd).catch(() => null);
    const prevHashes = bashBaselineHashes;
    bashBaselineHashes = null;

    if (!prevHashes || !repoRoot) return;

    const currentHashes = await captureGitFileHashes(repoRoot);
    await recordBashChanges(prevHashes, currentHashes, repoRoot);
  } catch (error) {
    await logInfo(cwd, "tool.execute.after", `bash-post error: ${error.message}`);
  }
}

async function recordBashChanges(prevHashes, currentHashes, repoRoot) {
  const config = await loadConfig(repoRoot);
  if (!config.enabled) return;

  const pending = await loadPendingLines(repoRoot);

  let trackedCount = 0;
  for (const [file, currentHash] of Object.entries(currentHashes)) {
    if (shouldIgnore(file)) continue;

    const absolutePath = path.join(repoRoot, file);
    const content = await safeRead(absolutePath);
    const lines = content.split(/\r?\n/).filter((l) => config.countBlankLines || l.trim() !== "");

    const existing = pending[file];
    let shouldRecord = false;

    if (existing) {
      const existingContents = existing.map((e) => e.content);
      const contentUnchanged =
        lines.length === existingContents.length &&
        lines.every((l, i) => l === existingContents[i]);
      shouldRecord = !contentUnchanged && (lines.length > 0 || existingContents.length > 0);
    } else {
      shouldRecord = prevHashes[file] !== currentHash && lines.length > 0;
    }

    if (shouldRecord) {
      await appendPendingLines(repoRoot, file, lines, {
        countBlankLines: config.countBlankLines,
        dedupeExisting: true,
        replace: true,
        aiTool: "opencode",
      });
      trackedCount++;
    }
  }

  await logInfo(repoRoot, "tool.execute.after", "bash-changes recorded", { trackedFiles: trackedCount });
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
      hashes[file] = createHash("md5").update(content).digest("hex");
    } catch {
      hashes[file] = "";
    }
  }));
  return hashes;
}

function extractFilePath(tool, args) {
  const toolName = String(tool ?? "").toLowerCase();
  if (!["edit", "write", "patch"].some((name) => toolName.includes(name))) return null;
  return args.filePath ?? args.file_path ?? args.path ?? args.file;
}

function snapshotKey(cwd, filePath) {
  return path.resolve(cwd, filePath);
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

function clearPendingFileEdited(key) {
  const timer = pendingFileEditedTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  pendingFileEditedTimers.delete(key);
}

async function log(client, level, message, extra = {}) {
  try {
    await client?.app?.log?.({
      body: {
        service: "ai-code-tracker",
        level,
        message,
        extra,
      },
    });
  } catch {
    // Logging must never break editing.
  }
}

