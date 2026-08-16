import fs from "node:fs/promises";
import path from "node:path";
import { safeFileName, trackerDir } from "./paths.js";

export const CSV_HEADER = "author,ai_tool,ai_lines,total_lines,is_ai_commit,commit_id,date,message";

function escapeCsv(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) { return text; }
  return `"${text.replaceAll('"', '""')}"`;
}

function formatRecord(record) {
  return [
    record.author,
    record.ai_tool,
    record.ai_lines,
    record.total_lines,
    Boolean(record.is_ai_commit),
    record.commit_id,
    record.date,
    record.message,
  ].map(escapeCsv).join(",");
}

export async function appendRecord(csvPath, record) {
  await fs.mkdir(path.dirname(csvPath), { recursive: true });
  let records = [];
  try {
    records = parseCsv(await fs.readFile(csvPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") { throw error; }
  }

  if (!records.some((existing) => existing.commit_id === record.commit_id)) {
    records.push(normalizeRecord(record));
  }

  await writeRecords(csvPath, records);
}

export async function removeRecords(csvPath, predicate) {
  let records = [];
  try {
    records = parseCsv(await fs.readFile(csvPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") { throw error; }
    return;
  }
  const kept = records.filter((r) => !predicate(r));
  if (kept.length !== records.length) { await writeRecords(csvPath, kept); }
}

export async function readRecords(repoRoot) {
  const dir = trackerDir(repoRoot);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") { return []; }
    throw error;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.endsWith(".csv")) { continue; }
    const text = await fs.readFile(path.join(dir, entry), "utf8");
    records.push(...parseCsv(text));
  }
  return records;
}

export async function pruneStaleRecords(repoRoot, isCommitInHistory, author) {
  const dir = trackerDir(repoRoot);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") { return { pruned: 0 }; }
    throw error;
  }

  const authorFilename = author ? `${safeFileName(author)}.csv` : null;
  let pruned = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".csv")) { continue; }
    if (authorFilename && entry !== authorFilename) { continue; }
    const csvPath = path.join(dir, entry);
    const records = parseCsv(await fs.readFile(csvPath, "utf8"));
    const kept = [];
    for (const record of records) {
      if (await isCommitInHistory(record.commit_id)) {
        kept.push(record);
      } else {
        pruned += 1;
      }
    }
    if (kept.length !== records.length) { await writeRecords(csvPath, kept); }
  }

  return { pruned };
}

async function writeRecords(csvPath, records) {
  await fs.mkdir(path.dirname(csvPath), { recursive: true });
  const lines = [CSV_HEADER, ...records.map((record) => formatRecord(normalizeRecord(record)))];
  await fs.writeFile(csvPath, `﻿${lines.join("\n")}\n`, "utf8");
}

export function parseCsv(text) {
  const rows = parseRows(text.replace(/^﻿/, ""));
  if (rows.length === 0) { return []; }
  const [header, ...dataRows] = rows;

  return dataRows
    .filter((row) => row.length > 1 || row[0] !== "")
    .map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""])))
    .map((row) => ({
      ...row,
      ai_lines: Number(row.ai_lines || 0),
      total_lines: Number(row.total_lines || 0),
      is_ai_commit: row.is_ai_commit === "true",
    }));
}

function normalizeRecord(record) {
  return {
    ...record,
    ai_lines: Number(record.ai_lines || 0),
    total_lines: Number(record.total_lines || 0),
    is_ai_commit: Boolean(record.is_ai_commit),
  };
}

function parseRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
