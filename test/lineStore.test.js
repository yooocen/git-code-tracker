import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendPendingLines, consumeMatchedLines, loadPendingLines } from "../src/tracker/lineStore.js";

const E = (content, consumed = false, ai_tool) => ({
  content,
  ...(ai_tool ? { ai_tool } : {}),
  consumed,
});

test("appends nonblank pending lines with consumed=false", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-lines-"));

  await appendPendingLines(repoRoot, "src/a.js", ["one", "", "one"]);

  assert.deepEqual(await loadPendingLines(repoRoot), {
    "src/a.js": [E("one"), E("one")],
  });
});

test("marks matched lines as consumed instead of removing them", () => {
  const result = consumeMatchedLines(
    { "src/a.js": [E("one"), E("one"), E("two")] },
    { "src/a.js": ["one"] },
  );

  assert.deepEqual(result, {
    "src/a.js": [E("one", true), E("one", false), E("two", false)],
  });
});

test("does not re-consume already consumed lines", () => {
  const result = consumeMatchedLines(
    { "src/a.js": [E("one", true), E("one", false), E("two", false)] },
    { "src/a.js": ["one"] },
  );

  assert.deepEqual(result, {
    "src/a.js": [E("one", true), E("one", true), E("two", false)],
  });
});

test("consumes across multiple files", () => {
  const result = consumeMatchedLines(
    {
      "src/a.js": [E("x"), E("y")],
      "src/b.ts": [E("z")],
    },
    { "src/a.js": ["x"], "src/b.ts": ["z"] },
  );

  assert.deepEqual(result, {
    "src/a.js": [E("x", true), E("y", false)],
    "src/b.ts": [E("z", true)],
  });
});

test("ignores matched lines for files not in the store", () => {
  const result = consumeMatchedLines(
    { "src/a.js": [E("x")] },
    { "src/other.js": ["x"] },
  );

  assert.deepEqual(result, {
    "src/a.js": [E("x", false)],
  });
});

test("preserves all entries when every line is consumed", () => {
  const result = consumeMatchedLines(
    {
      "src/a.js": [E("x"), E("y")],
      "src/b.ts": [E("z")],
    },
    { "src/a.js": ["x", "y"], "src/b.ts": ["z"] },
  );

  assert.deepEqual(result, {
    "src/a.js": [E("x", true), E("y", true)],
    "src/b.ts": [E("z", true)],
  });
});

test("loadPendingLines migrates legacy string array format", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-lines-"));
  const { pendingLinesPath } = await import("../src/tracker/paths.js");
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  const raw = { "src/a.js": ["old-line-1", "old-line-2"] };
  await fs.writeFile(pendingLinesPath(repoRoot), JSON.stringify(raw), "utf8");

  const loaded = await loadPendingLines(repoRoot);
  assert.deepEqual(loaded, {
    "src/a.js": [E("old-line-1"), E("old-line-2")],
  });
});

test("replace mode overwrites existing pending lines for a file", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-lines-"));

  await appendPendingLines(repoRoot, "src/a.js", ["old-1", "old-2"]);
  assert.deepEqual(await loadPendingLines(repoRoot), {
    "src/a.js": [E("old-1"), E("old-2")],
  });

  await appendPendingLines(repoRoot, "src/a.js", ["new-1"], { replace: true });
  assert.deepEqual(await loadPendingLines(repoRoot), {
    "src/a.js": [E("new-1")],
  });
});

test("replace mode preserves the first AI tool for a file", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-lines-"));

  await appendPendingLines(repoRoot, "src/a.js", ["old"], { aiTool: "claude-code" });
  await appendPendingLines(repoRoot, "src/a.js", ["new"], { replace: true, aiTool: "opencode" });

  assert.deepEqual(await loadPendingLines(repoRoot), {
    "src/a.js": [E("new", false, "claude-code")],
  });
});

test("replace mode clears file entry when no non-blank lines remain", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-lines-"));

  await appendPendingLines(repoRoot, "src/a.js", ["keep-me"]);
  await appendPendingLines(repoRoot, "src/a.js", [""], { replace: true });

  assert.deepEqual(await loadPendingLines(repoRoot), {});
});

test("replace mode does not affect other files", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-lines-"));

  await appendPendingLines(repoRoot, "src/a.js", ["a1"]);
  await appendPendingLines(repoRoot, "src/b.js", ["b1"]);
  await appendPendingLines(repoRoot, "src/a.js", ["a2"], { replace: true });

  assert.deepEqual(await loadPendingLines(repoRoot), {
    "src/a.js": [E("a2")],
    "src/b.js": [E("b1")],
  });
});

test("dedupeExisting does not deduplicate within same batch", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-lines-"));

  await appendPendingLines(repoRoot, "src/a.js", ["x", "y", "x", "y"], { dedupeExisting: true });

  assert.deepEqual(await loadPendingLines(repoRoot), {
    "src/a.js": [E("x"), E("y"), E("x"), E("y")],
  });
});
