export function buildPendingCommit({
  pendingLines,
  addedLines,
  countBlankLines = false,
  renamedFiles = {},
  missingPendingFiles = [],
}) {
  let totalLines = 0;
  let aiLines = 0;
  let aiTool;
  const matchedLines = {};
  const pendingPools = buildPendingPools(pendingLines);
  const renameSourcesByTarget = buildRenameSourcesByTarget(renamedFiles);
  const missingPending = new Set(missingPendingFiles);

  for (const [filePath, lines] of Object.entries(addedLines ?? {})) {
    const counted = countBlankLines ? lines : lines.filter((l) => l.trim() !== "");
    totalLines += counted.length;

    for (const line of counted) {
      const sourcePath = findMatchSource({
        pendingPools,
        filePath,
        line,
        renameSources: renameSourcesByTarget[filePath] ?? [],
        missingPending,
      });
      if (!sourcePath) { continue; }
      aiLines += 1;
      aiTool ??= sourcePath.ai_tool;
      const matchedSourcePath = sourcePath.filePath;
      if (!matchedLines[matchedSourcePath]) { matchedLines[matchedSourcePath] = []; }
      matchedLines[matchedSourcePath].push(line);
    }
  }

  return {
    ai_lines: aiLines,
    total_lines: totalLines,
    matched_lines: matchedLines,
    ...(aiTool ? { ai_tool: aiTool } : {}),
  };
}

function buildPendingPools(pendingLines) {
  const pools = {};
  for (const [filePath, entries] of Object.entries(pendingLines ?? {})) {
    pools[filePath] = entries
      .filter((e) => !e.consumed)
      .map((e) => ({ content: e.content, ai_tool: e.ai_tool }));
  }
  return pools;
}

function buildRenameSourcesByTarget(renamedFiles) {
  const sourcesByTarget = {};
  for (const [source, target] of Object.entries(renamedFiles ?? {})) {
    if (!sourcesByTarget[target]) { sourcesByTarget[target] = []; }
    sourcesByTarget[target].push(source);
  }
  return sourcesByTarget;
}

function findMatchSource({ pendingPools, filePath, line, renameSources, missingPending }) {
  const direct = consumeFromPool(pendingPools[filePath], line);
  if (direct) { return { filePath, ai_tool: direct.ai_tool }; }

  for (const source of renameSources) {
    const renamed = consumeFromPool(pendingPools[source], line);
    if (renamed) { return { filePath: source, ai_tool: renamed.ai_tool }; }
  }

  for (const source of missingPending) {
    if (source === filePath || renameSources.includes(source)) { continue; }
    const fallback = consumeFromPool(pendingPools[source], line);
    if (fallback) { return { filePath: source, ai_tool: fallback.ai_tool }; }
  }

  return null;
}

function consumeFromPool(pool, line) {
  if (!pool) { return false; }
  const index = pool.findIndex((entry) => entry.content === line);
  if (index === -1) { return false; }
  return pool.splice(index, 1)[0];
}
