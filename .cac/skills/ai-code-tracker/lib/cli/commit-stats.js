#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendRecord, pruneStaleRecords } from "../tracker/csv.js";
import { git, gitRaw, gitRepoRoot } from "../tracker/git.js";
import { parseAddedLinesFromDiff, parseRenamedFilesFromDiff } from "../tracker/diff.js";
import { buildPendingCommit } from "../tracker/stats.js";
import { consumeMatchedLines, loadPendingLines, savePendingLines } from "../tracker/lineStore.js";
import { atomicWriteJson, atomicWriteText } from "../tracker/lock.js";
import { archiveDir, authorCsvPath, pendingCommitPath, pendingLinesPath, snapshotDir, trackingMessagePath } from "../tracker/paths.js";
import { loadConfig } from "../tracker/shared.js";
import { logInfo, logError, startTimer } from "../tracker/logger.js";
import { runPushUpload } from "../tracker/pushUpload.js";

const execFileAsync = promisify(execFile);

export async function runCommitStats(mode, options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const gitImpl = options.git ?? git;
  const gitRawImpl = options.gitRaw ?? gitRaw;
  const pushUploadImpl = options.runPushUpload ?? runPushUpload;
  const repoRoot = options.repoRoot ?? await gitRepoRoot(cwd);

  if (env.AI_CODE_TRACKER_SKIP === "1") {
    await logInfo(repoRoot, "commit-stats", "skipped: skip-env", { mode });
    return { skipped: "skip-env" };
  }

  const config = await loadConfig(repoRoot);
  if (!config.enabled) {
    await logInfo(repoRoot, "commit-stats", "skipped: disabled", { mode });
    return { skipped: "disabled" };
  }

  await logInfo(repoRoot, `commit-stats.${mode}`, "enter");

  if (mode === "prune") {
    return runPrune({ repoRoot, gitImpl });
  }

  await pruneCsvRecordsIfPossible(repoRoot, gitImpl);

  if (mode === "pre-commit") {
    return runPreCommit({ repoRoot, gitRawImpl, env, processTreeReader: options.processTreeReader });
  }
  if (mode === "post-commit") {
    return runPostCommit({ repoRoot, gitImpl, gitRawImpl, env });
  }
  if (mode === "pre-push") {
    const archiveResult = await runPrePush({ repoRoot, now: options.now });
    await logInfo(repoRoot, "commit-stats.pre-push", "upload enter");
    const stdin = options.stdin ?? (config.uploadUrl ? await readStdin() : "");
    const uploadResult = await pushUploadImpl({ repoRoot, cwd, stdin });
    if (uploadResult.skipped) {
      await logInfo(repoRoot, "commit-stats.pre-push", `upload skipped: ${uploadResult.skipped}`);
    } else if (uploadResult.queued) {
      await logError(repoRoot, "pre-push", "upload failed, batch queued for retry", {
        uploaded: uploadResult.uploaded,
        queued: uploadResult.queued,
        error: uploadResult.error ?? "POST returned non-ok",
      });
    } else {
      await logInfo(repoRoot, "pre-push", "upload complete", { uploaded: uploadResult.uploaded ?? 0 });
    }
    return { ...archiveResult, upload: uploadResult };
  }

  throw new Error(`Unknown commit-stats mode: ${mode}`);
}

async function runPrune({ repoRoot, gitImpl }) {
  const timer = startTimer();
  const result = await pruneCsvRecordsIfPossible(repoRoot, gitImpl);
  await logInfo(repoRoot, "prune", "complete", { ...result, durationMs: timer.elapsedMs() });
  return { pruned: true, ...result };
}

async function runPrePush({ repoRoot, now = new Date() }) {
  const timer = startTimer();
  const files = [pendingLinesPath(repoRoot), pendingCommitPath(repoRoot), trackingMessagePath(repoRoot)];
  const existing = [];
  for (const file of files) {
    try {
      await fs.access(file);
      existing.push(file);
    } catch {
      // Missing pending files are already clean.
    }
  }

  if (existing.length === 0) {
    await logInfo(repoRoot, "pre-push", "skipped: no pending files", { durationMs: timer.elapsedMs() });
    return { skipped: "no-pending-files" };
  }

  const target = path.join(archiveDir(repoRoot), archiveStamp(now));
  await fs.mkdir(target, { recursive: true });
  for (const file of existing) {
    await fs.copyFile(file, path.join(target, path.basename(file)));
    await fs.rm(file, { force: true });
  }

  await logInfo(repoRoot, "pre-push", "archived pending files", { files: existing.map((f) => path.basename(f)), archive: target, durationMs: timer.elapsedMs() });
  return { archived: existing.map((file) => path.basename(file)), archive: target };
}

async function runPreCommit({ repoRoot, gitRawImpl, env, processTreeReader }) {
  const timer = startTimer();
  const diff = await gitRawImpl(["diff", "--cached", "--unified=0", "--find-renames"], { cwd: repoRoot });
  const addedLines = removeTrackingFiles(parseAddedLinesFromDiff(diff));
  const renamedFiles = parseRenamedFilesFromDiff(diff);
  const pendingLines = await loadPendingLines(repoRoot);
  const config = await loadConfig(repoRoot);
  const pendingCommit = buildPendingCommit({
    pendingLines,
    addedLines,
    countBlankLines: config.countBlankLines,
    renamedFiles,
    missingPendingFiles: await missingPendingFiles(repoRoot, pendingLines),
  });

  const withCommitSource = {
    ...pendingCommit,
    is_ai_commit: await isAiCreatedCommit(env, { processTreeReader }),
  };

  await atomicWriteJson(pendingCommitPath(repoRoot), withCommitSource, {
    operation: "write pending commit tracking stats",
  });

  const stagedFiles = Object.keys(addedLines);
  await logInfo(repoRoot, "pre-commit", "complete", {
    stagedFiles: stagedFiles.length,
    totalAddedLines: pendingCommit.total_lines,
    aiLines: pendingCommit.ai_lines,
    isAiCommit: withCommitSource.is_ai_commit,
    durationMs: timer.elapsedMs(),
  });
  return { written: withCommitSource };
}

async function missingPendingFiles(repoRoot, pendingLines) {
  const missing = [];
  for (const filePath of Object.keys(pendingLines ?? {})) {
    try {
      await fs.access(path.join(repoRoot, filePath));
    } catch {
      missing.push(filePath);
    }
  }
  return missing;
}

async function runPostCommit({ repoRoot, gitImpl, gitRawImpl, env }) {
  const timer = startTimer();
  if (Number(env.AI_CODE_TRACKER_DEPTH || "0") > 0) {
    throw new Error("Refusing recursive ai-code-tracker post-commit execution");
  }

  const fullMessage = await gitRawImpl(["log", "-1", "--pretty=%B"], { cwd: repoRoot });
  const subject = fullMessage.split(/\r?\n/)[0] || "";
  const config = await loadConfig(repoRoot);
  const suffix = config.trackingCommitSuffix || "[ai-tracking]";
  if (fullMessage.includes(suffix)) {
    await logInfo(repoRoot, "post-commit", "skipped: tracking commit", { subject, durationMs: timer.elapsedMs() });
    return { skipped: "tracking-commit" };
  }

  const parentCount = await gitImpl(["rev-parse", "--verify", "HEAD^2"], { cwd: repoRoot }).then(() => 2).catch(() => 1);
  if (parentCount > 1) {
    await logInfo(repoRoot, "post-commit", "skipped: merge commit", { subject, parents: parentCount, durationMs: timer.elapsedMs() });
    return { skipped: "merge-commit" };
  }

  const pendingPath = pendingCommitPath(repoRoot);
  let pendingCommit;
  try {
    pendingCommit = JSON.parse(await fs.readFile(pendingPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      await logInfo(repoRoot, "post-commit", "skipped: no pending commit", { durationMs: timer.elapsedMs() });
      return { skipped: "no-pending-commit" };
    }
    throw error;
  }

  await logInfo(repoRoot, "post-commit", "processing commit", { subject, aiLines: pendingCommit.ai_lines, totalLines: pendingCommit.total_lines });

  const commitId = await gitImpl(["rev-parse", "HEAD"], { cwd: repoRoot });
  const author = await gitImpl(["log", "-1", "--pretty=%an"], { cwd: repoRoot });
  const date = formatCommitDate(await gitImpl(["log", "-1", "--pretty=%ad", "--date=iso-strict"], { cwd: repoRoot }));
  const messageSubject = subject;

  let aiLines = pendingCommit.ai_lines;
  let totalLines = pendingCommit.total_lines;
  if (aiLines === 0 && totalLines > 0) {
    const source = await findCherryPickSource(repoRoot, fullMessage);
    if (source) {
      const sourceRecord = await findCsvRecord(repoRoot, source);
      if (sourceRecord) {
        aiLines = sourceRecord.ai_lines;
        totalLines = sourceRecord.total_lines;
        await logInfo(repoRoot, "post-commit", "cherry-pick: copied AI lines from source", { source, aiLines, totalLines });
      }
    }
  }

  const csvPath = authorCsvPath(repoRoot, author);
  const autoTracking = config.autoTrackingCommit !== false;

  const csvRelPath = path.relative(repoRoot, csvPath).replaceAll(path.sep, "/");
  const parentBlob = await gitImpl(["rev-parse", `HEAD~1:${csvRelPath}`], { cwd: repoRoot }).catch(() => null);
  const currentBlob = await gitImpl(["rev-parse", `HEAD:${csvRelPath}`], { cwd: repoRoot }).catch(() => null);
  const csvChangedInCommit = parentBlob !== null && parentBlob !== currentBlob;

  const record = {
    author,
    ai_tool: pendingCommit.ai_tool ?? "",
    ai_lines: aiLines,
    total_lines: totalLines,
    is_ai_commit: pendingCommit.is_ai_commit === true,
    commit_id: commitId,
    date,
    message: messageSubject,
  };

  if (autoTracking) {
    if (csvChangedInCommit) {
      await logInfo(repoRoot, "post-commit", "CSV already in commit, skipped tracking", { commitId: commitId.slice(0, 7) });
    } else {
      await appendRecord(csvPath, record);

      await atomicWriteText(trackingMessagePath(repoRoot), trackingMessage(fullMessage, suffix), {
        operation: "write tracking commit message",
      });
      await stageTrackingFiles({ repoRoot, gitImpl, csvPath });
      await assertOnlyTrackingStaged(repoRoot, gitRawImpl);

      await gitImpl(["commit", "-F", ".ai-tracking/tracking-message.txt"], {
        cwd: repoRoot,
        env: { ...process.env, AI_CODE_TRACKER_SKIP: "1", AI_CODE_TRACKER_DEPTH: "1" },
      });
    }

    await fs.rm(pendingPath, { force: true });
    await fs.rm(trackingMessagePath(repoRoot), { force: true });
  } else {
    if (!csvChangedInCommit) {
      await appendRecord(csvPath, record);
      await logInfo(repoRoot, "post-commit", "autoTrackingCommit disabled: CSV record appended", { commitId: commitId.slice(0, 7) });
    } else {
      await logInfo(repoRoot, "post-commit", "autoTrackingCommit disabled: CSV already in commit, skipped", { commitId: commitId.slice(0, 7) });
    }

    await fs.rm(pendingPath, { force: true });
  }

  const pendingLines = await loadPendingLines(repoRoot);
  await savePendingLines(repoRoot, consumeMatchedLines(pendingLines, pendingCommit.matched_lines));

  // Clean up original snapshots so the next edit starts fresh from the committed state
  await cleanOriginalSnapshots(repoRoot);

  await logInfo(repoRoot, "post-commit", "complete", { commitId: commitId.slice(0, 7), author, aiLines: pendingCommit.ai_lines, totalLines: pendingCommit.total_lines, autoTracking, durationMs: timer.elapsedMs() });
  return { committed: true };
}

async function stageTrackingFiles({ repoRoot, gitImpl, csvPath }) {
  await gitImpl(["add", csvPath], { cwd: repoRoot });
  await gitImpl([
    "rm",
    "--cached",
    "-f",
    "--ignore-unmatch",
    pendingLinesPath(repoRoot),
    pendingCommitPath(repoRoot),
    trackingMessagePath(repoRoot),
  ], { cwd: repoRoot });
}

async function assertOnlyTrackingStaged(repoRoot, gitRawImpl) {
  const names = (await gitRawImpl(["diff", "--cached", "--name-only"], { cwd: repoRoot }))
    .split(/\r?\n/)
    .filter(Boolean);
  const invalid = names.filter((name) => !name.startsWith(".ai-tracking/"));
  if (invalid.length > 0) {
    throw new Error(`Refusing tracking commit with non-tracking staged files: ${invalid.join(", ")}`);
  }
}

function removeTrackingFiles(addedLines) {
  return Object.fromEntries(
    Object.entries(addedLines).filter(([filePath]) => !filePath.startsWith(".ai-tracking/")),
  );
}

function trackingMessage(fullMessage, suffix = "[ai-tracking]") {
  const trimmed = String(fullMessage || "").replace(/\s+$/u, "");
  const lines = trimmed.split(/\r?\n/);
  const subject = lines.shift() || "AI code tracking";
  const body = lines.join("\n").trimEnd();
  if (body) {
    return `${subject}\n${body}\n\n${suffix}\n`;
  }
  return `${subject}\n\n${suffix}\n`;
}

function formatCommitDate(value) {
  return String(value || "").replace("T", " ").replace(/([+-]\d{2}:\d{2}|Z)$/u, "");
}

function archiveStamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/u, "Z").replace(/[:]/g, "");
}

async function isAiCreatedCommit(env, options = {}) {
  if (env.AI_CODE_TRACKER_PROCESS_TREE) { return includesAiAgent(env.AI_CODE_TRACKER_PROCESS_TREE); }
  const processTree = options.processTreeReader ? await options.processTreeReader() : await readProcessTree();
  return includesAiAgent(processTree);
}

async function readProcessTree() {
  if (process.platform === "win32") { return readWindowsProcessTree(); }
  return readPosixProcessTree();
}

async function readPosixProcessTree() {
  const commands = [];
  let pid = process.ppid;
  const seen = new Set();

  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const stat = await readProcStat(pid) ?? await readPsStat(pid);
    if (!stat) { break; }
    commands.push(stat.command);
    pid = stat.parentPid;
  }

  return commands.join("\n");
}

async function readWindowsProcessTree(startPid = process.ppid, execFileImpl = execFileAsync) {
  const script = `
$pidToRead = ${Number(startPid) || 0}
$items = @()
for ($i = 0; $i -lt 32 -and $pidToRead -gt 0; $i++) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToRead"
  if ($null -eq $p) { break }
  $items += (($p.Name + " " + $p.CommandLine).Trim())
  $pidToRead = [int]$p.ParentProcessId
}
$items -join [Environment]::NewLine
`;
  try {
    const { stdout } = await execFileImpl("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

async function readProcStat(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    const openParen = stat.indexOf("(");
    if (openParen === -1 || closeParen === -1) { return null; }
    const command = stat.slice(openParen + 1, closeParen);
    const rest = stat.slice(closeParen + 2).split(" ");
    return { command, parentPid: Number(rest[1] || 0) };
  } catch {
    return null;
  }
}

async function readPsStat(pid, execFileImpl = execFileAsync) {
  try {
    const { stdout } = await execFileImpl("ps", ["-o", "ppid=", "-o", "comm=", "-p", String(pid)], {
      maxBuffer: 1024 * 1024,
    });
    const line = stdout.trim();
    const match = line.match(/^(\d+)\s+(.+)$/u);
    if (!match) { return null; }
    return { parentPid: Number(match[1]), command: match[2] };
  } catch {
    return null;
  }
}

function includesAiAgent(processTree) {
  return String(processTree || "").split(/\r?\n/).some((command) =>
    /(^|[\\/\s])(?:opencode|code-?agent|claude)(?:\.exe)?($|[\\/\s])/i.test(command),
  );
}

async function pruneCsvRecordsIfPossible(repoRoot, gitImpl) {
  try {
    await gitImpl(["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
    let author;
    try {
      author = await gitImpl(["config", "user.name"], { cwd: repoRoot });
    } catch {
      author = null;
    }
    await pruneStaleRecords(repoRoot, async (commitId) => {
      try {
        const branches = await gitImpl(["branch", "--all", "--contains", commitId], { cwd: repoRoot });
        return branches.trim().length > 0;
      } catch {
        return false;
      }
    }, author || undefined);
  } catch {
    // Pruning should not block commits; the next successful tracker run can retry.
  }
}

async function findCherryPickSource(repoRoot, fullMessage) {
  const match = fullMessage.match(/\(cherry picked from commit ([0-9a-f]+)\)/);
  return match?.[1] ?? null;
}

async function findCsvRecord(repoRoot, commitId) {
  try {
    const { readRecords } = await import("../tracker/csv.js");
    const records = await readRecords(repoRoot);
    return records.find((r) => r.commit_id === commitId || r.commit_id.startsWith(commitId)) ?? null;
  } catch {
    return null;
  }
}

async function cleanOriginalSnapshots(repoRoot) {
  const dir = snapshotDir(repoRoot);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith("original-") && entry.endsWith(".json")) {
      await fs.rm(path.join(dir, entry), { force: true });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCommitStats(process.argv[2]).catch((error) => {
    console.error(`[ai-code-tracker] ${error.message}`);
    process.exitCode = 1;
  });
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
