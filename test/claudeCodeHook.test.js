import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runClaudeCodeHook } from "../src/claude-code/claude-code-hook.js";
import { loadPendingLines } from "../src/tracker/lineStore.js";
import { snapshotDir } from "../src/tracker/paths.js";

const execFileAsync = promisify(execFile);

async function fakeRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-claude-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, ".ai-tracking", "config.json"),
    JSON.stringify({ enabled: true, ignore: [], countBlankLines: false }),
    "utf8",
  );
  return repoRoot;
}

function preInput(repoRoot, filePath, toolUseId = "toolu_001") {
  return JSON.stringify({
    cwd: repoRoot,
    tool_name: "Edit",
    tool_input: { file_path: path.resolve(repoRoot, filePath) },
    tool_use_id: toolUseId,
    hook_event_name: "PreToolUse",
  });
}

function postInput(repoRoot, filePath, toolUseId = "toolu_001") {
  return JSON.stringify({
    cwd: repoRoot,
    tool_name: "Edit",
    tool_input: { file_path: path.resolve(repoRoot, filePath) },
    tool_use_id: toolUseId,
    hook_event_name: "PostToolUse",
  });
}

test("pre hook stores snapshot to disk", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\n", "utf8");

  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/a.js") });

  const snapshot = JSON.parse(await fs.readFile(path.join(snapshotDir(repoRoot), "toolu_001.json"), "utf8"));
  assert.equal(snapshot.content, "one\n");
  assert.equal(snapshot.filePath, "src/a.js");
});

test("post hook reads snapshot and records added lines", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\n", "utf8");

  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/a.js", "toolu_002") });

  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\ntwo\nthree\n", "utf8");

  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/a.js", "toolu_002") });

  assert.deepEqual(await loadPendingLines(repoRoot), {
    "src/a.js": [
      { content: "two", ai_tool: "claude-code", consumed: false },
      { content: "three", ai_tool: "claude-code", consumed: false },
    ],
  });

  await assert.rejects(fs.access(path.join(snapshotDir(repoRoot), "toolu_002.json")));
});

test("post hook is graceful when snapshot is missing", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "content\n", "utf8");

  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/a.js", "toolu_nosnap") });

  assert.deepEqual(await loadPendingLines(repoRoot), {});
});

test("hook skips disabled config", async () => {
  const repoRoot = await fakeRepo();
  await fs.writeFile(
    path.join(repoRoot, ".ai-tracking", "config.json"),
    JSON.stringify({ enabled: false, ignore: [] }),
    "utf8",
  );
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\n", "utf8");

  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/a.js") });

  const dir = snapshotDir(repoRoot);
  let entries;
  try { entries = await fs.readdir(dir); } catch { entries = []; }
  assert.equal(entries.length, 0);
});

test("hook skips ignored file paths", async () => {
  const repoRoot = await fakeRepo();
  await fs.writeFile(
    path.join(repoRoot, ".ai-tracking", "config.json"),
    JSON.stringify({ enabled: true, ignore: ["node_modules/**"], countBlankLines: false }),
    "utf8",
  );
  await fs.mkdir(path.join(repoRoot, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "node_modules", "pkg.js"), "code\n", "utf8");

  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "node_modules/pkg.js") });

  const dir = snapshotDir(repoRoot);
  let entries;
  try { entries = await fs.readdir(dir); } catch { entries = []; }
  assert.equal(entries.length, 0);
});

test("hook normalizes Windows backslash paths to forward slashes", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\r\n", "utf8");

  const winInput = JSON.stringify({
    cwd: repoRoot.replace(/\//g, "\\"),
    tool_name: "Edit",
    tool_input: { file_path: path.resolve(repoRoot, "src/a.js").replace(/\//g, "\\") },
    tool_use_id: "toolu_win",
    hook_event_name: "PreToolUse",
  });

  await runClaudeCodeHook("pre", { stdin: winInput });

  const snapshot = JSON.parse(await fs.readFile(path.join(snapshotDir(repoRoot), "toolu_win.json"), "utf8"));
  assert.equal(snapshot.filePath, "src/a.js");
  assert.equal(snapshot.content, "one\r\n");
});

test("hook handles CRLF line endings in file content", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\r\n", "utf8");

  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/a.js", "toolu_crlf") });

  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\r\ntwo\r\nthree\r\n", "utf8");

  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/a.js", "toolu_crlf") });

  const pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/a.js"].length > 0);
  assert.ok(pending["src/a.js"].some((e) => e.content === "two"));
  assert.ok(pending["src/a.js"].some((e) => e.content === "three"));
});

test("stale snapshots are cleaned up on pre invocation", async () => {
  const repoRoot = await fakeRepo();
  const dir = snapshotDir(repoRoot);
  await fs.mkdir(dir, { recursive: true });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "src", "b.js"), "one\n", "utf8");

  const staleSnapshot = { content: "old\n", filePath: "src/old.js", timestamp: Date.now() - 15 * 60 * 1000 };
  await fs.writeFile(path.join(dir, "toolu_stale.json"), JSON.stringify(staleSnapshot), "utf8");

  const now = Date.now();
  const staleTime = new Date(now - 15 * 60 * 1000);
  await fs.utimes(path.join(dir, "toolu_stale.json"), staleTime, staleTime);

  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/a.js", "toolu_fresh") });

  const entries = await fs.readdir(dir);
  assert.ok(!entries.includes("toolu_stale.json"));
  assert.ok(entries.includes("toolu_fresh.json"));
});

// --- Bash tool hook tests ---

function bashPreInput(repoRoot, toolUseId = "toolu_bash01") {
  return JSON.stringify({
    cwd: repoRoot,
    tool_name: "Bash",
    tool_input: { command: "cp src/a.js src/b.js" },
    tool_use_id: toolUseId,
    hook_event_name: "PreToolUse",
  });
}

function bashPostInput(repoRoot, toolUseId = "toolu_bash01") {
  return JSON.stringify({
    cwd: repoRoot,
    tool_name: "Bash",
    tool_input: { command: "cp src/a.js src/b.js" },
    tool_use_id: toolUseId,
    hook_event_name: "PostToolUse",
  });
}

test("Bash pre-hook captures file hashes", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "hello\n", "utf8");

  await runClaudeCodeHook("pre", { stdin: bashPreInput(repoRoot, "toolu_bp1") });

  const snapshot = JSON.parse(await fs.readFile(path.join(snapshotDir(repoRoot), "bash-toolu_bp1.json"), "utf8"));
  assert.ok(snapshot["src/a.js"]);
  assert.equal(typeof snapshot["src/a.js"], "string");
  assert.ok(snapshot["src/a.js"].length > 0);
});

test("Bash post-hook records new file created by shell command", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "hello\n", "utf8");

  // Pre-hook captures state before cp
  await runClaudeCodeHook("pre", { stdin: bashPreInput(repoRoot, "toolu_bcp1") });

  // Simulate cp creating a new file
  await fs.writeFile(path.join(repoRoot, "src", "b.js"), "world\nline2\n", "utf8");

  // Post-hook detects new file and records its lines
  await runClaudeCodeHook("post", { stdin: bashPostInput(repoRoot, "toolu_bcp1") });

  const pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/b.js"]);
  assert.ok(pending["src/b.js"].some((e) => e.content === "world"));
  assert.ok(pending["src/b.js"].some((e) => e.content === "line2"));
});

test("Bash post-hook replaces pending lines for already-tracked file when content changes", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\n", "utf8");

  // First, Edit hook tracks src/a.js: added "two"
  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/a.js", "toolu_edit1") });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\ntwo\n", "utf8");
  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/a.js", "toolu_edit1") });

  // Then Bash overwrites src/a.js with different content
  await runClaudeCodeHook("pre", { stdin: bashPreInput(repoRoot, "toolu_bashrep") });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\nthree\n", "utf8");
  await runClaudeCodeHook("post", { stdin: bashPostInput(repoRoot, "toolu_bashrep") });

  const pending = await loadPendingLines(repoRoot);
  assert.ok(!pending["src/a.js"].some((e) => e.content === "two"), "old line 'two' should be replaced");
  assert.ok(pending["src/a.js"].some((e) => e.content === "three"));
  assert.ok(pending["src/a.js"].some((e) => e.content === "one"));
});

test("Bash post-hook replaces pending on second Bash command to same file", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "v1\n", "utf8");

  // First Bash: overwrite with v2 content
  await runClaudeCodeHook("pre", { stdin: bashPreInput(repoRoot, "toolu_b1") });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "v1\nv2\n", "utf8");
  await runClaudeCodeHook("post", { stdin: bashPostInput(repoRoot, "toolu_b1") });

  let pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/a.js"].some((e) => e.content === "v2"));

  // Second Bash: overwrite with v3 content
  await runClaudeCodeHook("pre", { stdin: bashPreInput(repoRoot, "toolu_b2") });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "v1\nv3\n", "utf8");
  await runClaudeCodeHook("post", { stdin: bashPostInput(repoRoot, "toolu_b2") });

  pending = await loadPendingLines(repoRoot);
  assert.ok(!pending["src/a.js"].some((e) => e.content === "v2"), "v2 should be replaced by second Bash");
  assert.ok(pending["src/a.js"].some((e) => e.content === "v3"));
});

test("Bash post-hook replaces with fewer lines (file shortened)", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "line1\nline2\nline3\n", "utf8");

  // First Bash tracks 3 lines
  await runClaudeCodeHook("pre", { stdin: bashPreInput(repoRoot, "toolu_short1") });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "line1\nline2\nline3\nline4\n", "utf8");
  await runClaudeCodeHook("post", { stdin: bashPostInput(repoRoot, "toolu_short1") });

  let pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/a.js"].some((e) => e.content === "line4"));

  // Second Bash shortens the file — removes line3 and line4, adds line5
  await runClaudeCodeHook("pre", { stdin: bashPreInput(repoRoot, "toolu_short2") });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "line1\nline2\nline5\n", "utf8");
  await runClaudeCodeHook("post", { stdin: bashPostInput(repoRoot, "toolu_short2") });

  pending = await loadPendingLines(repoRoot);
  assert.ok(!pending["src/a.js"].some((e) => e.content === "line3"), "removed line3 should not remain");
  assert.ok(!pending["src/a.js"].some((e) => e.content === "line4"), "removed line4 should not remain");
  assert.ok(pending["src/a.js"].some((e) => e.content === "line5"));
});

test("Bash post-hook detects new file even when other files are already staged", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\n", "utf8");

  // Stage src/a.js first (simulates git add before cp sync)
  const { execFile: exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);
  await execAsync("git", ["add", "src/a.js"], { cwd: repoRoot });

  // Now Bash command creates a new file (simulates cp sync)
  await runClaudeCodeHook("pre", { stdin: bashPreInput(repoRoot, "toolu_staged1") });
  await fs.writeFile(path.join(repoRoot, "src", "b.js"), "new-file-content\n", "utf8");
  await runClaudeCodeHook("post", { stdin: bashPostInput(repoRoot, "toolu_staged1") });

  const pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/b.js"], "Bash hook should detect new file even when other files are staged");
  assert.ok(pending["src/b.js"].some((e) => e.content === "new-file-content"));
});

test("Bash post-hook skips ignored files", async () => {
  const repoRoot = await fakeRepo();
  await fs.writeFile(
    path.join(repoRoot, ".ai-tracking", "config.json"),
    JSON.stringify({ enabled: true, ignore: ["dist/**"], countBlankLines: false }),
    "utf8",
  );
  await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });

  await runClaudeCodeHook("pre", { stdin: bashPreInput(repoRoot, "toolu_bign") });

  await fs.writeFile(path.join(repoRoot, "dist", "out.js"), "compiled\n", "utf8");

  await runClaudeCodeHook("post", { stdin: bashPostInput(repoRoot, "toolu_bign") });

  const pending = await loadPendingLines(repoRoot);
  assert.equal(pending["dist/out.js"], undefined);
});

test("Bash post-hook cleans up snapshot file", async () => {
  const repoRoot = await fakeRepo();

  await runClaudeCodeHook("pre", { stdin: bashPreInput(repoRoot, "toolu_bclean") });
  await runClaudeCodeHook("post", { stdin: bashPostInput(repoRoot, "toolu_bclean") });

  await assert.rejects(fs.access(path.join(snapshotDir(repoRoot), "bash-toolu_bclean.json")));
});

test("Bash post-hook detects content change in already-modified file (cp overwrite)", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  // File already exists and is modified
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "original\n", "utf8");

  // Pre-hook captures hash of current content
  await runClaudeCodeHook("pre", { stdin: bashPreInput(repoRoot, "toolu_bover") });

  // cp overwrites with new content (simulating cp src dest)
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "original\nnew-line-from-cp\n", "utf8");

  // Post-hook should detect the hash change and track it
  await runClaudeCodeHook("post", { stdin: bashPostInput(repoRoot, "toolu_bover") });

  const pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/a.js"]);
  assert.ok(pending["src/a.js"].some((e) => e.content === "new-line-from-cp"));
});

// --- Multi-edit tests (original snapshot persistence) ---

test("re-editing same file replaces pending lines instead of appending", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base\n", "utf8");

  // Edit 1: base → base + step1
  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/a.js", "toolu_re1") });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base\nstep1\n", "utf8");
  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/a.js", "toolu_re1") });

  let pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/a.js"].some((e) => e.content === "step1"));

  // Edit 2: base + step1 → base + step2
  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/a.js", "toolu_re2") });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base\nstep2\n", "utf8");
  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/a.js", "toolu_re2") });

  pending = await loadPendingLines(repoRoot);
  assert.ok(!pending["src/a.js"].some((e) => e.content === "step1"), "step1 should not remain as stale residue");
  assert.ok(pending["src/a.js"].some((e) => e.content === "step2"));
  assert.equal(pending["src/a.js"].length, 1);
});

test("cumulative additive edits preserve all added lines", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base\n", "utf8");

  // Edit 1: base → base + line2
  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/a.js", "toolu_add1") });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base\nline2\n", "utf8");
  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/a.js", "toolu_add1") });

  // Edit 2: base + line2 → base + line2 + line3
  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/a.js", "toolu_add2") });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base\nline2\nline3\n", "utf8");
  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/a.js", "toolu_add2") });

  const pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/a.js"].some((e) => e.content === "line2"));
  assert.ok(pending["src/a.js"].some((e) => e.content === "line3"));
});

test("new file created then edited tracks only final lines", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });

  // Write creates the file
  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/new.js", "toolu_nw1") });
  await fs.writeFile(path.join(repoRoot, "src/new.js"), "v1-line1\nv1-line2\n", "utf8");
  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/new.js", "toolu_nw1") });

  // Then edit modifies it
  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/new.js", "toolu_nw2") });
  await fs.writeFile(path.join(repoRoot, "src/new.js"), "v1-line1\nv2-line2\n", "utf8");
  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/new.js", "toolu_nw2") });

  const pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/new.js"].some((e) => e.content === "v1-line1"));
  assert.ok(pending["src/new.js"].some((e) => e.content === "v2-line2"));
  assert.ok(!pending["src/new.js"].some((e) => e.content === "v1-line2"), "v1-line2 should not remain");
});

test("re-editing different files does not interfere", async () => {
  const repoRoot = await fakeRepo();
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base-a\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "src", "b.js"), "base-b\n", "utf8");

  // Edit file a
  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/a.js", "toolu_xa1") });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base-a\na1\n", "utf8");
  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/a.js", "toolu_xa1") });

  // Edit file b
  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/b.js", "toolu_xb1") });
  await fs.writeFile(path.join(repoRoot, "src", "b.js"), "base-b\nb1\n", "utf8");
  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/b.js", "toolu_xb1") });

  // Re-edit file a — should not affect file b
  await runClaudeCodeHook("pre", { stdin: preInput(repoRoot, "src/a.js", "toolu_xa2") });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base-a\na2\n", "utf8");
  await runClaudeCodeHook("post", { stdin: postInput(repoRoot, "src/a.js", "toolu_xa2") });

  const pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/a.js"].some((e) => e.content === "a2"));
  assert.ok(!pending["src/a.js"].some((e) => e.content === "a1"));
  assert.ok(pending["src/b.js"].some((e) => e.content === "b1"));
});
