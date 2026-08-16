import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runCommitStats } from "../src/cli/commit-stats.js";
import { loadPendingLines, savePendingLines } from "../src/tracker/lineStore.js";
import { pendingCommitPath, pendingLinesPath, trackingMessagePath } from "../src/tracker/paths.js";

test("pre-commit writes pending commit without staging csv", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));
  await savePendingLines(repoRoot, { "src/a.js": [{ content: "ai line", consumed: false }] });

  const diff = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -0,0 +1,2 @@
+ai line
+human line
`;

  await runCommitStats("pre-commit", {
    repoRoot,
    env: {},
    gitRaw: async () => diff,
    processTreeReader: async () => "sh\ngit\nbash",
  });

  assert.deepEqual(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")), {
    ai_lines: 1,
    total_lines: 2,
    is_ai_commit: false,
    matched_lines: { "src/a.js": ["ai line"] },
  });
});

test("pre-commit matches pending lines when a new AI-created file is renamed before commit", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));
  await savePendingLines(repoRoot, { "src/draft.js": [{ content: "ai line", consumed: false }] });

  const diff = `diff --git a/src/final.js b/src/final.js
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/final.js
@@ -0,0 +1,2 @@
+ai line
+human line
`;

  await runCommitStats("pre-commit", {
    repoRoot,
    env: {},
    gitRaw: async () => diff,
    processTreeReader: async () => "sh\ngit\nbash",
  });

  assert.deepEqual(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")), {
    ai_lines: 1,
    total_lines: 2,
    is_ai_commit: false,
    matched_lines: { "src/draft.js": ["ai line"] },
  });
});

test("pre-commit marks commits created by AI via process tree", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));

  await runCommitStats("pre-commit", {
    repoRoot,
    env: {},
    gitRaw: async () => "",
    processTreeReader: async () => "sh\ngit\nclaude\nbash",
  });

  assert.deepEqual(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")), {
    ai_lines: 0,
    total_lines: 0,
    is_ai_commit: true,
    matched_lines: {},
  });
});

test("pre-commit marks commits created under opencode process tree", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));

  await runCommitStats("pre-commit", {
    repoRoot,
    env: { AI_CODE_TRACKER_PROCESS_TREE: "git\nsh\nopencode" },
    gitRaw: async () => "",
  });

  assert.equal(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")).is_ai_commit, true);
});

test("pre-commit marks commits created under Windows opencode.exe process tree", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));

  await runCommitStats("pre-commit", {
    repoRoot,
    env: {},
    gitRaw: async () => "",
    processTreeReader: async () => [
      "git.exe commit -m test",
      "sh.exe .git/hooks/pre-commit",
      "opencode.exe run",
      "WindowsTerminal.exe",
    ].join("\r\n"),
  });

  assert.equal(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")).is_ai_commit, true);
});

test("pre-commit does not mark non-opencode process tree as AI commit", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));

  await runCommitStats("pre-commit", {
    repoRoot,
    env: {},
    gitRaw: async () => "",
    processTreeReader: async () => "git.exe\ncmd.exe\nWindowsTerminal.exe",
  });

  assert.equal(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")).is_ai_commit, false);
});

test("pre-commit marks commits created under claude process tree", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));

  await runCommitStats("pre-commit", {
    repoRoot,
    env: {},
    gitRaw: async () => "",
    processTreeReader: async () => "sh .git/hooks/pre-commit\ngit commit\nclaude\nzsh",
  });

  assert.equal(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")).is_ai_commit, true);
});

test("pre-commit marks commits created under code-agent process tree", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));

  await runCommitStats("pre-commit", {
    repoRoot,
    env: {},
    gitRaw: async () => "",
    processTreeReader: async () => "sh .git/hooks/pre-commit\ngit commit\ncode-agent run\nbash",
  });

  assert.equal(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")).is_ai_commit, true);
});

test("pre-commit marks commits created under codeagent process tree", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));

  await runCommitStats("pre-commit", {
    repoRoot,
    env: {},
    gitRaw: async () => "",
    processTreeReader: async () => "sh .git/hooks/pre-commit\ngit commit\ncodeagent\nbash",
  });

  assert.equal(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")).is_ai_commit, true);
});

test("pre-commit does not false-positive on claudia or decode-agent", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));

  await runCommitStats("pre-commit", {
    repoRoot,
    env: {},
    gitRaw: async () => "",
    processTreeReader: async () => "sh .git/hooks/pre-commit\ngit commit\nclaudia\ndecode-agent\nbash",
  });

  assert.equal(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")).is_ai_commit, false);
});

test("pre-commit detects claude in Windows path with backslash", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));

  await runCommitStats("pre-commit", {
    repoRoot,
    env: {},
    gitRaw: async () => "",
    processTreeReader: async () => [
      "C:\\Users\\dev\\.claude\\bin\\claude.exe",
      "C:\\Program Files\\Git\\bin\\git.exe",
      "C:\\Windows\\System32\\cmd.exe",
    ].join("\r\n"),
  });

  assert.equal(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")).is_ai_commit, true);
});

test("pre-commit detects opencode.exe with full Windows path", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));

  await runCommitStats("pre-commit", {
    repoRoot,
    env: {},
    gitRaw: async () => "",
    processTreeReader: async () => [
      "git.exe commit -m test",
      "sh.exe .git/hooks/pre-commit",
      "C:\\Users\\dev\\go\\bin\\opencode.exe run",
      "WindowsTerminal.exe",
    ].join("\r\n"),
  });

  assert.equal(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")).is_ai_commit, true);
});

test("pre-commit does not false-positive on path containing 'claude' substring", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));

  await runCommitStats("pre-commit", {
    repoRoot,
    env: {},
    gitRaw: async () => "",
    processTreeReader: async () => [
      "git.exe commit -m test",
      "sh.exe .git/hooks/pre-commit",
      "C:\\Users\\claude-chocolate\\app.exe",
      "cmd.exe",
    ].join("\r\n"),
  });

  assert.equal(JSON.parse(await fs.readFile(pendingCommitPath(repoRoot), "utf8")).is_ai_commit, false);
});

test("post-commit writes csv and consumes matched lines", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));
  await savePendingLines(repoRoot, { "src/a.js": [{ content: "ai line", consumed: false }, { content: "left", consumed: false }] });
  await fs.writeFile(pendingCommitPath(repoRoot), JSON.stringify({
    ai_lines: 1,
    total_lines: 2,
    ai_tool: "claude-code",
    is_ai_commit: true,
    matched_lines: { "src/a.js": ["ai line"] },
  }), "utf8");

  const gitCalls = [];
  await runCommitStats("post-commit", {
    repoRoot,
    env: {},
    git: async (args) => {
      gitCalls.push(args);
      const key = args.join(" ");
      if (key === "rev-parse --verify HEAD^2") { throw new Error("no second parent"); }
      if (key === "rev-parse --verify HEAD") { return "abc123"; }
      if (key.startsWith("branch --all --contains")) { return "main\n"; }
      if (key === "rev-parse HEAD") { return "abc123"; }
      if (key === "log -1 --pretty=%an") { return "cyd"; }
      if (key === "log -1 --pretty=%ad --date=iso-strict") { return "2026-05-05T12:34:56+08:00"; }
      return "";
    },
    gitRaw: async (args) => {
      const key = args.join(" ");
      if (key === "log -1 --pretty=%B") { return "Implement thing\n\nBody\n"; }
      if (key === "diff --cached --name-only") { return ".ai-tracking/cyd.csv\n"; }
      return "";
    },
  });

  const csv = await fs.readFile(path.join(repoRoot, ".ai-tracking", "cyd.csv"), "utf8");
  assert.match(csv, /is_ai_commit/);
  assert.match(csv, /claude-code,1,2,true,abc123,2026-05-05 12:34:56/);
  assert.deepEqual(await loadPendingLines(repoRoot), { "src/a.js": [{ content: "ai line", consumed: true }, { content: "left", consumed: false }] });
  assert(gitCalls.some((args) => args[0] === "commit"));
});

test("post-commit skips tracking when commit already includes CSV (autoTrackingCommit true)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  const csvPath = path.join(repoRoot, ".ai-tracking", "cyd.csv");
  await fs.writeFile(csvPath, "author,ai_lines,total_lines,is_ai_commit,commit_id,date,message\ncyd,1,2,true,oldhash,2026-05-05 10:00:00,Old\n", "utf8");

  await fs.writeFile(pendingCommitPath(repoRoot), JSON.stringify({
    ai_lines: 1,
    total_lines: 2,
    is_ai_commit: true,
    matched_lines: {},
  }), "utf8");

  const gitCalls = [];
  await runCommitStats("post-commit", {
    repoRoot,
    env: {},
    git: async (args) => {
      gitCalls.push(args);
      const key = args.join(" ");
      if (key === "rev-parse --verify HEAD^2") { throw new Error("no second parent"); }
      if (key === "rev-parse --verify HEAD") { return "abc123"; }
      if (key.startsWith("branch --all --contains")) { return "main\n"; }
      if (key === "rev-parse HEAD") { return "abc123"; }
      if (key === "log -1 --pretty=%an") { return "cyd"; }
      if (key === "log -1 --pretty=%ad --date=iso-strict") { return "2026-05-05T12:34:56+08:00"; }
      if (key === "rev-parse HEAD~1:.ai-tracking/cyd.csv") { return "parentblob"; }
      if (key === "rev-parse HEAD:.ai-tracking/cyd.csv") { return "currentblob"; }
      return "";
    },
    gitRaw: async (args) => {
      const key = args.join(" ");
      if (key === "log -1 --pretty=%B") { return "Implement thing\n\nBody\n"; }
      return "";
    },
  });

  // No new record appended, no tracking commit created
  const csv = await fs.readFile(csvPath, "utf8");
  const records = csv.trim().split("\n").slice(1);
  assert.equal(records.length, 1);
  assert.match(records[0], /^cyd,1,2,true,oldhash/);
  assert(!gitCalls.some((args) => args[0] === "commit"), "should not create tracking commit");
});

test("post-commit copies AI lines from cherry-pick source", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });

  // Simulate the original commit's CSV already exists
  const originalCsv = path.join(repoRoot, ".ai-tracking", "dev.csv");
  await fs.writeFile(originalCsv, "author,ai_lines,total_lines,is_ai_commit,commit_id,date,message\ndev,8,20,true,deadbeef,2026-05-10 10:00:00,Add feature\n", "utf8");

  // Cherry-pick: pending-commit has 0 AI lines (pending-lines already consumed)
  await fs.writeFile(pendingCommitPath(repoRoot), JSON.stringify({
    ai_lines: 0,
    total_lines: 20,
    is_ai_commit: true,
    matched_lines: {},
  }), "utf8");

  await runCommitStats("post-commit", {
    repoRoot,
    env: {},
    git: async (args) => {
      const key = args.join(" ");
      if (key === "rev-parse --verify HEAD^2") { throw new Error("no second parent"); }
      if (key === "rev-parse --verify HEAD") { return "abc123"; }
      if (key.startsWith("branch --all --contains")) { return "main\n"; }
      if (key === "rev-parse HEAD") { return "abc123"; }
      if (key === "log -1 --pretty=%an") { return "dev"; }
      if (key === "log -1 --pretty=%ad --date=iso-strict") { return "2026-05-14T10:00:00+08:00"; }
      return "";
    },
    gitRaw: async (args) => {
      const key = args.join(" ");
      if (key === "log -1 --pretty=%B") { return "Add feature\n\n(cherry picked from commit deadbeef)\n"; }
      if (key === "diff --cached --name-only") { return ".ai-tracking/dev.csv\n"; }
      return "";
    },
  });

  const csv = await fs.readFile(originalCsv, "utf8");
  const records = csv.trim().split("\n").slice(1);
  assert.equal(records.length, 2);
  assert.match(records[0], /^dev,,8,20,true,deadbeef/);
  assert.match(records[1], /^dev,,8,20,true,abc123/);
});

test("post-commit does not copy AI lines when no cherry-pick source", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });

  await fs.writeFile(pendingCommitPath(repoRoot), JSON.stringify({
    ai_lines: 0,
    total_lines: 10,
    is_ai_commit: false,
    matched_lines: {},
  }), "utf8");

  await runCommitStats("post-commit", {
    repoRoot,
    env: {},
    git: async (args) => {
      const key = args.join(" ");
      if (key === "rev-parse --verify HEAD^2") { throw new Error("no second parent"); }
      if (key === "rev-parse --verify HEAD") { return "abc123"; }
      if (key.startsWith("branch --all --contains")) { return "main\n"; }
      if (key === "rev-parse HEAD") { return "abc123"; }
      if (key === "log -1 --pretty=%an") { return "dev"; }
      if (key === "log -1 --pretty=%ad --date=iso-strict") { return "2026-05-14T10:00:00+08:00"; }
      return "";
    },
    gitRaw: async (args) => {
      const key = args.join(" ");
      if (key === "log -1 --pretty=%B") { return "Normal commit\n\nNo cherry-pick here\n"; }
      if (key === "diff --cached --name-only") { return ".ai-tracking/dev.csv\n"; }
      return "";
    },
  });

  const csv = await fs.readFile(path.join(repoRoot, ".ai-tracking", "dev.csv"), "utf8");
  assert.match(csv, /dev,,0,10,false,abc123/);
});

test("pre-push archives and clears pending tracking files", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(pendingLinesPath(repoRoot), JSON.stringify({ "src/a.js": ["ai"] }), "utf8");
  await fs.writeFile(pendingCommitPath(repoRoot), JSON.stringify({ ai_lines: 1 }), "utf8");
  await fs.writeFile(trackingMessagePath(repoRoot), "message [ai-tracking]\n", "utf8");

  const result = await runCommitStats("pre-push", {
    repoRoot,
    now: new Date("2026-05-06T03:04:05Z"),
    git: async () => "",
  });

  assert.deepEqual(result.archived.sort(), ["pending-commit.json", "pending-lines.json", "tracking-message.txt"]);
  await assert.rejects(fs.access(pendingLinesPath(repoRoot)));
  await assert.rejects(fs.access(pendingCommitPath(repoRoot)));
  await assert.rejects(fs.access(trackingMessagePath(repoRoot)));
  assert.equal(
    await fs.readFile(path.join(repoRoot, ".ai-tracking", "archive", "2026-05-06T030405Z", "pending-lines.json"), "utf8"),
    JSON.stringify({ "src/a.js": ["ai"] }),
  );
});

test("pre-push uploads the announced refs after archiving tracking files", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(pendingLinesPath(repoRoot), JSON.stringify({ "src/a.js": ["ai"] }), "utf8");
  const stdin = `refs/heads/main ${"a".repeat(40)} refs/heads/main ${"0".repeat(40)}\n`;
  const upload = { uploaded: 1 };
  const uploadCalls = [];

  const result = await runCommitStats("pre-push", {
    cwd: repoRoot,
    repoRoot,
    stdin,
    now: new Date("2026-05-06T03:04:05Z"),
    git: async () => "",
    runPushUpload: async (options) => {
      uploadCalls.push(options);
      return upload;
    },
  });

  assert.deepEqual(result.upload, upload);
  assert.deepEqual(uploadCalls, [{ repoRoot, cwd: repoRoot, stdin }]);
  await assert.rejects(fs.access(pendingLinesPath(repoRoot)));
});

test("post-commit skips tracking commit with suffix at end of message", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });

  const result = await runCommitStats("post-commit", {
    repoRoot,
    env: {},
    git: async (args) => {
      if (args.join(" ") === "rev-parse --verify HEAD^2") { throw new Error("no second parent"); }
      return "";
    },
    gitRaw: async (args) => {
      const key = args.join(" ");
      if (key === "log -1 --pretty=%B") { return "Implement thing\n\nSome body\n\n[ai-tracking]\n"; }
      return "";
    },
  });

  assert.deepEqual(result, { skipped: "tracking-commit" });
});

test("post-commit skips tracking commit with custom suffix from config", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-"));
  await fs.mkdir(path.join(repoRoot, ".ai-tracking"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".ai-tracking", "config.json"), JSON.stringify({
    enabled: true,
    countBlankLines: false,
    trackingCommitSuffix: "[custom-suffix]",
    autoTrackingCommit: true,
  }), "utf8");

  const result = await runCommitStats("post-commit", {
    repoRoot,
    env: {},
    git: async (args) => {
      if (args.join(" ") === "rev-parse --verify HEAD^2") { throw new Error("no second parent"); }
      return "";
    },
    gitRaw: async (args) => {
      const key = args.join(" ");
      if (key === "log -1 --pretty=%B") { return "Implement thing\n\n[custom-suffix]\n"; }
      return "";
    },
  });

  assert.deepEqual(result, { skipped: "tracking-commit" });
});
