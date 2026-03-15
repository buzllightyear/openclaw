import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "../utils.js";
import { cosineSimilarity, parseEmbedding } from "./internal.js";

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

export type SearchSource = string;

export type SearchRowResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: SearchSource;
};

export async function searchVector(params: {
  db: DatabaseSync;
  vectorTable: string;
  providerModel: string;
  queryVec: number[];
  limit: number;
  snippetMaxChars: number;
  ensureVectorReady: (dimensions: number) => Promise<boolean>;
  sourceFilterVec: { sql: string; params: SearchSource[] };
  sourceFilterChunks: { sql: string; params: SearchSource[] };
}): Promise<SearchRowResult[]> {
  if (params.queryVec.length === 0 || params.limit <= 0) {
    return [];
  }
  if (await params.ensureVectorReady(params.queryVec.length)) {
    const rows = params.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text,\n` +
          `       c.source,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM ${params.vectorTable} v\n` +
          `  JOIN chunks c ON c.id = v.id\n` +
          ` WHERE c.model = ? AND COALESCE(c.grade, 'ephemeral') != 'deleted'${params.sourceFilterVec.sql}\n` +
          ` ORDER BY dist ASC\n` +
          ` LIMIT ?`,
      )
      .all(
        vectorToBlob(params.queryVec),
        params.providerModel,
        ...params.sourceFilterVec.params,
        params.limit,
      ) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: SearchSource;
      dist: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 - row.dist,
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
    }));
  }

  const candidates = listChunks({
    db: params.db,
    providerModel: params.providerModel,
    sourceFilter: params.sourceFilterChunks,
  });
  const scored = candidates
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(params.queryVec, chunk.embedding),
    }))
    .filter((entry) => Number.isFinite(entry.score));
  return scored
    .toSorted((a, b) => b.score - a.score)
    .slice(0, params.limit)
    .map((entry) => ({
      id: entry.chunk.id,
      path: entry.chunk.path,
      startLine: entry.chunk.startLine,
      endLine: entry.chunk.endLine,
      score: entry.score,
      snippet: truncateUtf16Safe(entry.chunk.text, params.snippetMaxChars),
      source: entry.chunk.source,
    }));
}

export function listChunks(params: {
  db: DatabaseSync;
  providerModel: string;
  sourceFilter: { sql: string; params: SearchSource[] };
}): Array<{
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
  source: SearchSource;
}> {
  const rows = params.db
    .prepare(
      `SELECT id, path, start_line, end_line, text, embedding, source\n` +
        `  FROM chunks\n` +
        ` WHERE model = ? AND COALESCE(grade, 'ephemeral') != 'deleted'${params.sourceFilter.sql}`,
    )
    .all(params.providerModel, ...params.sourceFilter.params) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
    source: SearchSource;
  }>;

  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    embedding: parseEmbedding(row.embedding),
    source: row.source,
  }));
}

// P2/P3: Update recall_count and last_recalled_at for returned chunks
export function updateRecallStats(params: { db: DatabaseSync; chunkIds: string[] }): void {
  if (params.chunkIds.length === 0) {
    return;
  }
  const now = Date.now();
  try {
    const updateChunks = params.db.prepare(
      `UPDATE chunks SET recall_count = COALESCE(recall_count, 0) + 1,
                         last_recalled_at = ?
       WHERE id = ? AND COALESCE(grade, 'ephemeral') != 'deleted'`,
    );
    const updateStats = params.db.prepare(
      `INSERT INTO memory_stats (content_hash, recall_count, useful_count, last_recalled_at, updated_at)
       VALUES (?, 1, 0, ?, ?)
       ON CONFLICT(content_hash) DO UPDATE SET
         recall_count = recall_count + 1,
         last_recalled_at = excluded.last_recalled_at,
         updated_at = excluded.updated_at
       WHERE (SELECT deleted_at FROM memory_stats WHERE content_hash = excluded.content_hash) IS NULL`,
    );
    const getContentHash = params.db.prepare(
      `SELECT content_hash, text FROM chunks WHERE id = ? AND COALESCE(grade, 'ephemeral') != 'deleted'`,
    );
    for (const id of params.chunkIds) {
      updateChunks.run(now, id);
      const row = getContentHash.get(id) as
        | { content_hash: string | null; text: string }
        | undefined;
      if (row) {
        const contentHash =
          row.content_hash || createHash("sha256").update(row.text).digest("hex").slice(0, 16);
        updateStats.run(contentHash, now, now);
      }
    }
  } catch {
    // Recall tracking is best-effort; don't break search on DB write errors
  }
}

// P3: Update useful_count for chunks that contributed to a positively-received response
export function updateUsefulStats(params: { db: DatabaseSync; chunkIds: string[] }): void {
  if (params.chunkIds.length === 0) {
    return;
  }
  const now = Date.now();
  try {
    const updateChunks = params.db.prepare(
      `UPDATE chunks SET useful_count = COALESCE(useful_count, 0) + 1
       WHERE id = ? AND COALESCE(grade, 'ephemeral') != 'deleted'`,
    );
    const updateStats = params.db.prepare(
      `UPDATE memory_stats SET useful_count = useful_count + 1, updated_at = ?
       WHERE content_hash = (SELECT content_hash FROM chunks WHERE id = ?)
         AND deleted_at IS NULL`,
    );
    for (const id of params.chunkIds) {
      updateChunks.run(id);
      updateStats.run(now, id);
    }
  } catch {
    // Useful tracking is best-effort
  }
}

// P2: RRF (Reciprocal Rank Fusion) merge of vector + keyword results
export function rrfMerge(params: {
  vectorResults: SearchRowResult[];
  keywordResults: SearchRowResult[];
  vectorWeight?: number;
  ftsWeight?: number;
  limit: number;
}): SearchRowResult[] {
  const vectorWeight = params.vectorWeight ?? 0.7;
  const ftsWeight = params.ftsWeight ?? 0.3;
  const k = 60; // RRF constant

  const scoreMap = new Map<string, { result: SearchRowResult; rrfScore: number }>();

  for (let i = 0; i < params.vectorResults.length; i++) {
    const r = params.vectorResults[i];
    const rrfScore = vectorWeight / (k + i + 1);
    scoreMap.set(r.id, { result: r, rrfScore });
  }

  for (let i = 0; i < params.keywordResults.length; i++) {
    const r = params.keywordResults[i];
    const rrfScore = ftsWeight / (k + i + 1);
    const existing = scoreMap.get(r.id);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      scoreMap.set(r.id, { result: r, rrfScore });
    }
  }

  return Array.from(scoreMap.values())
    .toSorted((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, params.limit)
    .map((entry) => ({ ...entry.result, score: entry.rrfScore }));
}

export async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;
  providerModel: string | undefined;
  query: string;
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: SearchSource[] };
  buildFtsQuery: (raw: string) => string | null;
  bm25RankToScore: (rank: number) => number;
}): Promise<Array<SearchRowResult & { textScore: number }>> {
  if (params.limit <= 0) {
    return [];
  }
  const ftsQuery = params.buildFtsQuery(params.query);
  if (!ftsQuery) {
    return [];
  }

  // When providerModel is undefined (FTS-only mode), search all models
  const modelClause = params.providerModel ? " AND model = ?" : "";
  const modelParams = params.providerModel ? [params.providerModel] : [];

  const rows = params.db
    .prepare(
      `SELECT id, path, source, start_line, end_line, text,\n` +
        `       bm25(${params.ftsTable}) AS rank\n` +
        `  FROM ${params.ftsTable}\n` +
        ` WHERE ${params.ftsTable} MATCH ?${modelClause}${params.sourceFilter.sql}\n` +
        ` ORDER BY rank ASC\n` +
        ` LIMIT ?`,
    )
    .all(ftsQuery, ...modelParams, ...params.sourceFilter.params, params.limit) as Array<{
    id: string;
    path: string;
    source: SearchSource;
    start_line: number;
    end_line: number;
    text: string;
    rank: number;
  }>;

  // Post-filter: exclude deleted chunks (FTS table doesn't have grade)
  const filteredRows = rows.filter((row) => {
    try {
      const chunk = params.db.prepare(`SELECT grade FROM chunks WHERE id = ?`).get(row.id) as
        | { grade: string | null }
        | undefined;
      return !chunk || chunk.grade !== "deleted";
    } catch {
      return true; // Keep on error
    }
  });

  return filteredRows.map((row) => {
    const textScore = params.bm25RankToScore(row.rank);
    return {
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: textScore,
      textScore,
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
    };
  });
}
