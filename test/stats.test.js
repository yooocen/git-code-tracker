import test from "node:test";
import assert from "node:assert/strict";
import { buildPendingCommit } from "../src/tracker/stats.js";

const E = (content, consumed = false) => ({ content, consumed });

test("matches AI lines with duplicate-sensitive multiset semantics", () => {
  const pendingLines = {
    "src/a.js": [E("same"), E("same"), E("ai only")],
  };
  const addedLines = {
    "src/a.js": ["same", "same", "same", "human"],
  };

  assert.deepEqual(buildPendingCommit({ pendingLines, addedLines }), {
    ai_lines: 2,
    total_lines: 4,
    matched_lines: {
      "src/a.js": ["same", "same"],
    },
  });
});

test("returns an empty pending commit when there are no added lines", () => {
  assert.deepEqual(buildPendingCommit({ pendingLines: {}, addedLines: {} }), {
    ai_lines: 0,
    total_lines: 0,
    matched_lines: {},
  });
});

test("skips already consumed lines when matching", () => {
  const pendingLines = {
    "src/a.js": [E("line1", true), E("line1", false), E("line2", false)],
  };
  const addedLines = {
    "src/a.js": ["line1", "line2"],
  };

  assert.deepEqual(buildPendingCommit({ pendingLines, addedLines }), {
    ai_lines: 2,
    total_lines: 2,
    matched_lines: {
      "src/a.js": ["line1", "line2"],
    },
  });
});

test("does not match when all pending lines are already consumed", () => {
  const pendingLines = {
    "src/a.js": [E("x", true), E("y", true)],
  };
  const addedLines = {
    "src/a.js": ["x", "y"],
  };

  assert.deepEqual(buildPendingCommit({ pendingLines, addedLines }), {
    ai_lines: 0,
    total_lines: 2,
    matched_lines: {},
  });
});

test("buildPendingCommit matches lines from migrated legacy data", () => {
  const pendingLines = {
    "src/a.js": [E("legacy-line"), E("new-line")],
  };
  const addedLines = { "src/a.js": ["legacy-line", "human"] };

  const result = buildPendingCommit({ pendingLines, addedLines });
  assert.equal(result.ai_lines, 1);
  assert.deepEqual(result.matched_lines, { "src/a.js": ["legacy-line"] });
});

test("buildPendingCommit carries the first AI tool from matched lines", () => {
  const result = buildPendingCommit({
    pendingLines: {
      "src/a.js": [
        { content: "first", ai_tool: "claude-code", consumed: false },
        { content: "second", ai_tool: "opencode", consumed: false },
      ],
    },
    addedLines: { "src/a.js": ["first", "second"] },
  });

  assert.equal(result.ai_tool, "claude-code");
});

test("buildPendingCommit excludes blank lines from total when countBlankLines is false", () => {
  const pendingLines = {
    "src/a.js": [E("line1"), E("line2")],
  };
  const addedLines = { "src/a.js": ["line1", "", "line2", "   ", "human"] };

  const result = buildPendingCommit({ pendingLines, addedLines, countBlankLines: false });
  assert.equal(result.total_lines, 3);
  assert.equal(result.ai_lines, 2);
});

test("buildPendingCommit includes blank lines in total when countBlankLines is true", () => {
  const pendingLines = {
    "src/a.js": [E("line1"), E(""), E("line2")],
  };
  const addedLines = { "src/a.js": ["line1", "", "line2", "human"] };

  const result = buildPendingCommit({ pendingLines, addedLines, countBlankLines: true });
  assert.equal(result.total_lines, 4);
  assert.equal(result.ai_lines, 3);
});

test("buildPendingCommit matches renamed files using the original pending path", () => {
  const pendingLines = {
    "src/old.js": [E("ai line")],
  };
  const addedLines = {
    "src/new.js": ["ai line", "human line"],
  };

  assert.deepEqual(buildPendingCommit({
    pendingLines,
    addedLines,
    renamedFiles: { "src/old.js": "src/new.js" },
  }), {
    ai_lines: 1,
    total_lines: 2,
    matched_lines: {
      "src/old.js": ["ai line"],
    },
  });
});
