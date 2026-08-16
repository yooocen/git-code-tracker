import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AiCodeTrackerPlugin, recordEditedFile } from "../src/opencode/ai-code-tracker.js";
import { loadPendingLines } from "../src/tracker/lineStore.js";

const execFileAsync = promisify(execFile);

test("records added lines for edited file", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  await recordEditedFile({
    cwd: repoRoot,
    filePath: "src/a.js",
    before: "one\n",
    after: "one\ntwo\n",
  });

  assert.deepEqual(await loadPendingLines(repoRoot), {
    "src/a.js": [{ content: "two", ai_tool: "opencode", consumed: false }],
  });
});

test("records all lines as added when before snapshot is missing (new file)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const result = await recordEditedFile({
    cwd: repoRoot,
    filePath: "src/a.js",
    after: "one\ntwo\n",
  });

  assert.deepEqual(result, { recorded: 3 });
  assert.deepEqual(await loadPendingLines(repoRoot), {
    "src/a.js": [
      { content: "one", ai_tool: "opencode", consumed: false },
      { content: "two", ai_tool: "opencode", consumed: false },
    ],
  });
});

test("records all lines as added when before snapshot is empty (new file)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const result = await recordEditedFile({
    cwd: repoRoot,
    filePath: "src/a.js",
    before: "",
    after: "one\ntwo\n",
  });

  assert.deepEqual(result, { recorded: 3 });
  assert.deepEqual(await loadPendingLines(repoRoot), {
    "src/a.js": [
      { content: "one", ai_tool: "opencode", consumed: false },
      { content: "two", ai_tool: "opencode", consumed: false },
    ],
  });
});

test("plugin exposes opencode hook object and records tool before/after events", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  assert.equal(typeof plugin.event, "function");
  assert.equal(typeof plugin["tool.execute.before"], "function");
  assert.equal(typeof plugin["tool.execute.after"], "function");

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src/b.js"), "one\n", "utf8");
  await plugin["tool.execute.before"]({
    tool: "write",
    args: {
      filePath: "src/b.js",
    },
  });
  await fs.writeFile(path.join(repoRoot, "src/b.js"), "one\ntwo\n", "utf8");
  await plugin["tool.execute.after"]({
    tool: "write",
    args: {
      filePath: "src/b.js",
    },
  });

  assert.deepEqual(await loadPendingLines(repoRoot), {
    "src/b.js": [{ content: "two", ai_tool: "opencode", consumed: false }],
  });
});

test("plugin records all lines when Write creates a new file", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  // file does not exist yet — safeRead returns ""
  await plugin["tool.execute.before"]({
    tool: "write",
    args: {
      filePath: "src/new.js",
    },
  });
  // Write tool creates the file
  await fs.writeFile(path.join(repoRoot, "src/new.js"), "line1\nline2\n", "utf8");
  await plugin["tool.execute.after"]({
    tool: "write",
    args: {
      filePath: "src/new.js",
    },
  });

  assert.deepEqual(await loadPendingLines(repoRoot), {
    "src/new.js": [
      { content: "line1", ai_tool: "opencode", consumed: false },
      { content: "line2", ai_tool: "opencode", consumed: false },
    ],
  });
});

test("plugin replaces pending lines on re-edit (no stale residue)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src/a.js"), "original\n", "utf8");

  // Edit 1: "original" → "original\nstep1\n"
  await plugin["tool.execute.before"]({ tool: "edit", args: { filePath: "src/a.js" } });
  await fs.writeFile(path.join(repoRoot, "src/a.js"), "original\nstep1\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "edit", args: { filePath: "src/a.js" } });

  let pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/a.js"].some((e) => e.content === "step1"));

  // Edit 2: "original\nstep1\n" → "original\nstep2\n"
  await plugin["tool.execute.before"]({ tool: "edit", args: { filePath: "src/a.js" } });
  await fs.writeFile(path.join(repoRoot, "src/a.js"), "original\nstep2\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "edit", args: { filePath: "src/a.js" } });

  pending = await loadPendingLines(repoRoot);
  // step1 should be gone (replaced by step2), not left as stale residue
  assert.ok(!pending["src/a.js"].some((e) => e.content === "step1"), "step1 should not remain as stale residue");
  assert.ok(pending["src/a.js"].some((e) => e.content === "step2"));
  // Only the diff from original→final: "step2" added
  assert.equal(pending["src/a.js"].length, 1);
});

test("plugin preserves cumulative diff across multiple additive edits", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src/a.js"), "base\n", "utf8");

  // Edit 1: add line2
  await plugin["tool.execute.before"]({ tool: "edit", args: { filePath: "src/a.js" } });
  await fs.writeFile(path.join(repoRoot, "src/a.js"), "base\nline2\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "edit", args: { filePath: "src/a.js" } });

  // Edit 2: add line3 (line2 kept)
  await plugin["tool.execute.before"]({ tool: "edit", args: { filePath: "src/a.js" } });
  await fs.writeFile(path.join(repoRoot, "src/a.js"), "base\nline2\nline3\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "edit", args: { filePath: "src/a.js" } });

  const pending = await loadPendingLines(repoRoot);
  // Original→final: "base\n" → "base\nline2\nline3\n" = added "line2" and "line3"
  assert.ok(pending["src/a.js"].some((e) => e.content === "line2"));
  assert.ok(pending["src/a.js"].some((e) => e.content === "line3"));
});

test("plugin tracks new file then subsequent edit correctly", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });

  // Write creates the file
  await plugin["tool.execute.before"]({ tool: "write", args: { filePath: "src/new.js" } });
  await fs.writeFile(path.join(repoRoot, "src/new.js"), "v1-line1\nv1-line2\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "write", args: { filePath: "src/new.js" } });

  // Then Edit modifies it: replace v1-line2 with v2-line2
  await plugin["tool.execute.before"]({ tool: "edit", args: { filePath: "src/new.js" } });
  await fs.writeFile(path.join(repoRoot, "src/new.js"), "v1-line1\nv2-line2\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "edit", args: { filePath: "src/new.js" } });

  const pending = await loadPendingLines(repoRoot);
  // Original (empty) → final: all lines added, but v1-line2 is gone
  assert.ok(pending["src/new.js"].some((e) => e.content === "v1-line1"));
  assert.ok(pending["src/new.js"].some((e) => e.content === "v2-line2"));
  assert.ok(!pending["src/new.js"].some((e) => e.content === "v1-line2"), "v1-line2 should not remain");
});

// --- Bash tool hook tests ---

test("Bash before/after records new file created by shell command", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "hello\n", "utf8");

  // Bash before: captures file hashes
  await plugin["tool.execute.before"]({ tool: "bash", args: { command: "cp src/a.js src/b.js", id: "bash-1" } });

  // Simulate cp creating a new file
  await fs.writeFile(path.join(repoRoot, "src", "b.js"), "world\nline2\n", "utf8");

  // Bash after: detects new file and records its lines
  await plugin["tool.execute.after"]({ tool: "bash", args: { command: "cp src/a.js src/b.js", id: "bash-1" } });

  const pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/b.js"]);
  assert.ok(pending["src/b.js"].some((e) => e.content === "world"));
  assert.ok(pending["src/b.js"].some((e) => e.content === "line2"));
});

test("Bash after replaces pending lines for already-tracked file when content changes", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\n", "utf8");

  // First, Edit hook tracks src/a.js: added "two"
  await plugin["tool.execute.before"]({ tool: "edit", args: { filePath: "src/a.js" } });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\ntwo\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "edit", args: { filePath: "src/a.js" } });

  // Then Bash overwrites src/a.js with different content: "one\nthree\n"
  await plugin["tool.execute.before"]({ tool: "bash", args: { command: "cp src/b.js src/a.js", id: "bash-replace" } });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\nthree\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "bash", args: { command: "cp src/b.js src/a.js", id: "bash-replace" } });

  const pending = await loadPendingLines(repoRoot);
  // Bash replaced pending with full-file content, so "two" is gone and "three" is present
  assert.ok(!pending["src/a.js"].some((e) => e.content === "two"), "old line 'two' should be replaced");
  assert.ok(pending["src/a.js"].some((e) => e.content === "three"));
  assert.ok(pending["src/a.js"].some((e) => e.content === "one"));
});

test("Bash after skips ignored files", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, ".ai-tracking", "config.json"),
    JSON.stringify({ enabled: true, ignore: ["dist/**"], countBlankLines: false }),
    "utf8",
  );

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });

  await plugin["tool.execute.before"]({ tool: "bash", args: { command: "build", id: "bash-ign" } });
  await fs.writeFile(path.join(repoRoot, "dist", "out.js"), "compiled\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "bash", args: { command: "build", id: "bash-ign" } });

  const pending = await loadPendingLines(repoRoot);
  assert.equal(pending["dist/out.js"], undefined);
});

test("Bash after detects content change in already-modified file", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "original\n", "utf8");

  // Bash before: captures hash of current content
  await plugin["tool.execute.before"]({ tool: "bash", args: { command: "cp src/b.js src/a.js", id: "bash-over" } });

  // cp overwrites with new content
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "original\nnew-line-from-cp\n", "utf8");

  // Bash after: should detect the hash change and track it
  await plugin["tool.execute.after"]({ tool: "bash", args: { command: "cp src/b.js src/a.js", id: "bash-over" } });

  const pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/a.js"]);
});

test("Bash after does not track unchanged files", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "unchanged\n", "utf8");

  await plugin["tool.execute.before"]({ tool: "bash", args: { command: "echo hello", id: "bash-unchanged" } });
  // No file changes
  await plugin["tool.execute.after"]({ tool: "bash", args: { command: "echo hello", id: "bash-unchanged" } });

  const pending = await loadPendingLines(repoRoot);
  assert.equal(pending["src/a.js"], undefined);
});

test("Bash replaces pending on second Bash command to same file", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "v1\n", "utf8");

  // First Bash: overwrite with v2
  await plugin["tool.execute.before"]({ tool: "bash", args: { command: "cp src/b.js src/a.js", id: "bash-d1" } });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "v1\nv2\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "bash", args: { command: "cp src/b.js src/a.js", id: "bash-d1" } });

  let pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/a.js"].some((e) => e.content === "v2"));

  // Second Bash: overwrite with v3
  await plugin["tool.execute.before"]({ tool: "bash", args: { command: "cp src/c.js src/a.js", id: "bash-d2" } });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "v1\nv3\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "bash", args: { command: "cp src/c.js src/a.js", id: "bash-d2" } });

  pending = await loadPendingLines(repoRoot);
  assert.ok(!pending["src/a.js"].some((e) => e.content === "v2"), "v2 should be replaced by second Bash");
  assert.ok(pending["src/a.js"].some((e) => e.content === "v3"));
});

test("Bash replaces with fewer lines (file shortened)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "line1\nline2\nline3\n", "utf8");

  // First Bash adds line4
  await plugin["tool.execute.before"]({ tool: "bash", args: { command: "append", id: "bash-s1" } });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "line1\nline2\nline3\nline4\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "bash", args: { command: "append", id: "bash-s1" } });

  let pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/a.js"].some((e) => e.content === "line4"));

  // Second Bash shortens: removes line3/line4, adds line5
  await plugin["tool.execute.before"]({ tool: "bash", args: { command: "truncate", id: "bash-s2" } });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "line1\nline2\nline5\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "bash", args: { command: "truncate", id: "bash-s2" } });

  pending = await loadPendingLines(repoRoot);
  assert.ok(!pending["src/a.js"].some((e) => e.content === "line3"), "removed line3 should not remain");
  assert.ok(!pending["src/a.js"].some((e) => e.content === "line4"), "removed line4 should not remain");
  assert.ok(pending["src/a.js"].some((e) => e.content === "line5"));
});

test("Edit then Bash then Edit: final Edit diff replaces Bash full-file tracking", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base\n", "utf8");

  // Edit 1: add step1
  await plugin["tool.execute.before"]({ tool: "edit", args: { filePath: "src/a.js" } });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base\nstep1\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "edit", args: { filePath: "src/a.js" } });

  // Bash overwrites with different content (simulating cp sync)
  await plugin["tool.execute.before"]({ tool: "bash", args: { command: "cp src/other src/a.js", id: "bash-cp1" } });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base\nstep1\nstep2\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "bash", args: { command: "cp src/other src/a.js", id: "bash-cp1" } });

  // Edit 2: replace step2 with step3
  await plugin["tool.execute.before"]({ tool: "edit", args: { filePath: "src/a.js" } });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "base\nstep1\nstep3\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "edit", args: { filePath: "src/a.js" } });

  const pending = await loadPendingLines(repoRoot);
  // Edit 2 uses replace=true from original snapshot, so final pending = diff(base → final)
  assert.ok(pending["src/a.js"].some((e) => e.content === "step1"));
  assert.ok(pending["src/a.js"].some((e) => e.content === "step3"));
  assert.ok(!pending["src/a.js"].some((e) => e.content === "step2"), "step2 should not remain after Edit replaces");
});

test("Bash hook detects new file even when other files are already staged", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-plugin-"));
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({ enabled: true, ignore: [] }), "utf8");

  const plugin = await AiCodeTrackerPlugin({ directory: repoRoot });

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "a.js"), "one\n", "utf8");

  // Stage src/a.js first
  await execFileAsync("git", ["add", "src/a.js"], { cwd: repoRoot });

  // Bash command creates a new file
  await plugin["tool.execute.before"]({ tool: "bash", args: { command: "cp src/a.js src/b.js", id: "bash-staged" } });
  await fs.writeFile(path.join(repoRoot, "src", "b.js"), "new-content\n", "utf8");
  await plugin["tool.execute.after"]({ tool: "bash", args: { command: "cp src/a.js src/b.js", id: "bash-staged" } });

  const pending = await loadPendingLines(repoRoot);
  assert.ok(pending["src/b.js"], "Bash hook should detect new file even when other files are staged");
  assert.ok(pending["src/b.js"].some((e) => e.content === "new-content"));
});
