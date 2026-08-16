import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendRecord, parseCsv, pruneStaleRecords } from "../src/tracker/csv.js";

test("escapes and parses CSV fields", () => {
  const records = parseCsv('author,ai_tool,ai_lines,total_lines,is_ai_commit,commit_id,date,message\ncyd,claude-code,1,2,true,abc,2026-05-05,"hello, ""world"""\n');
  assert.deepEqual(records, [{
    author: "cyd",
    ai_tool: "claude-code",
    ai_lines: 1,
    total_lines: 2,
    is_ai_commit: true,
    commit_id: "abc",
    date: "2026-05-05",
    message: 'hello, "world"',
  }]);
});

test("parses legacy CSV records as non-AI commits", () => {
  const records = parseCsv("author,ai_lines,total_lines,commit_id,date,message\ncyd,1,2,abc,2026-05-05,one\n");

  assert.equal(records[0].is_ai_commit, false);
});

test("appendRecord writes header once", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-csv-"));
  const file = path.join(dir, "cyd.csv");

  await appendRecord(file, { author: "cyd", ai_tool: "claude-code", ai_lines: 1, total_lines: 2, commit_id: "a", date: "2026-05-05", message: "one" });
  await appendRecord(file, { author: "cyd", ai_lines: 3, total_lines: 4, commit_id: "b", date: "2026-05-06", message: "two" });

  const text = await fs.readFile(file, "utf8");
  assert.equal(text.split("author,ai_tool,ai_lines").length, 2);
  assert.match(text, /author,ai_tool,ai_lines/);
  assert.match(text, /cyd,claude-code,1,2/);
  assert.match(text, /is_ai_commit/);
});

test("appendRecord is idempotent for an identical record", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-csv-"));
  const file = path.join(dir, "cyd.csv");
  const record = { author: "cyd", ai_lines: 1, total_lines: 2, commit_id: "a", date: "2026-05-05", message: "one" };

  await appendRecord(file, record);
  await appendRecord(file, record);

  assert.equal((await parseCsv(await fs.readFile(file, "utf8"))).length, 1);
});

test("pruneStaleRecords removes commits outside current history", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-csv-"));
  const file = path.join(repoRoot, ".ai-tracking", "cyd.csv");
  await appendRecord(file, { author: "cyd", ai_lines: 1, total_lines: 2, is_ai_commit: false, commit_id: "keep", date: "2026-05-05", message: "one" });
  await appendRecord(file, { author: "cyd", ai_lines: 1, total_lines: 2, is_ai_commit: true, commit_id: "drop", date: "2026-05-06", message: "two" });

  const result = await pruneStaleRecords(repoRoot, async (commitId) => commitId === "keep");

  assert.deepEqual(result, { pruned: 1 });
  assert.deepEqual((await parseCsv(await fs.readFile(file, "utf8"))).map((record) => record.commit_id), ["keep"]);
});
