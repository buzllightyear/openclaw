import type { DatabaseSync } from "node:sqlite";

export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  embeddingCacheTable: string;
  ftsTable: string;
  ftsEnabled: boolean;
}): { ftsAvailable: boolean; ftsError?: string } {
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    );
  `);
  params.db.exec(
    `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${params.embeddingCacheTable}(updated_at);`,
  );

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${params.ftsTable} USING fts5(\n` +
          `  text,\n` +
          `  id UNINDEXED,\n` +
          `  path UNINDEXED,\n` +
          `  source UNINDEXED,\n` +
          `  model UNINDEXED,\n` +
          `  start_line UNINDEXED,\n` +
          `  end_line UNINDEXED\n` +
          `);`,
      );
      ftsAvailable = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ftsAvailable = false;
      ftsError = message;
    }
  }

  ensureColumn(params.db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(params.db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");

  // P0: Memory upgrade — grade system columns
  ensureColumn(params.db, "chunks", "content_hash", "TEXT");
  ensureColumn(params.db, "chunks", "grade", "TEXT DEFAULT 'ephemeral'");
  ensureColumn(params.db, "chunks", "fact_type", "TEXT");
  ensureColumn(params.db, "chunks", "tags", "TEXT");
  ensureColumn(params.db, "chunks", "recall_count", "INTEGER DEFAULT 0");
  ensureColumn(params.db, "chunks", "useful_count", "INTEGER DEFAULT 0");
  ensureColumn(params.db, "chunks", "last_recalled_at", "INTEGER");

  // P0: Memory stats table — preserves recall/useful counts across reindexing
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS memory_stats (
      content_hash TEXT PRIMARY KEY,
      grade TEXT DEFAULT 'ephemeral',
      recall_count INTEGER DEFAULT 0,
      useful_count INTEGER DEFAULT 0,
      last_recalled_at INTEGER,
      deleted_at INTEGER,
      updated_at INTEGER
    );
  `);

  // P6: Perspective shift review queue
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS pending_perspective_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      existing_chunk_id TEXT NOT NULL,
      existing_text TEXT NOT NULL,
      existing_useful_count INTEGER DEFAULT 0,
      existing_grade TEXT,
      new_chunk_id TEXT NOT NULL,
      new_text TEXT NOT NULL,
      similarity REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
  `);

  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_grade ON chunks(grade);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_stats_grade ON memory_stats(grade);`);

  return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
}

function ensureColumn(
  db: DatabaseSync,
  table: "files" | "chunks",
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
