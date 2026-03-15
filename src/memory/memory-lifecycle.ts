import type { DatabaseSync } from "node:sqlite";

/**
 * P4: Memory lifecycle — promotion/demotion pipeline.
 *
 * Promotion:
 *   ephemeral  → recurring:  recall_count >= 3 AND useful_count >= 1
 *   recurring  → permanent:  recall_count >= 10 AND useful_count >= 5
 *
 * Demotion:
 *   recurring  → ephemeral:  last_recalled_at < 60 days ago AND useful_count == 0
 *   ephemeral  → soft-delete: last_recalled_at < 30 days ago AND recall_count <= 1
 *
 * permanent: no demotion (manual delete only)
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LifecycleResult {
  promoted: number;
  demoted: number;
  softDeleted: number;
}

export function runMemoryLifecycle(params: { db: DatabaseSync }): LifecycleResult {
  const now = Date.now();
  const sixtyDaysAgo = now - 60 * DAY_MS;
  const thirtyDaysAgo = now - 30 * DAY_MS;

  let promoted = 0;
  let demoted = 0;
  let softDeleted = 0;

  // --- Promotion ---

  // ephemeral → recurring (recall >= 3, useful is bonus not required)
  const promoteToRecurring = params.db.prepare(
    `UPDATE chunks SET grade = 'recurring', updated_at = ?
     WHERE grade = 'ephemeral'
       AND COALESCE(recall_count, 0) >= 3`,
  );
  const r1 = promoteToRecurring.run(now);
  promoted += Number(r1.changes);

  // recurring → permanent (recall >= 10, useful >= 1 as quality signal)
  const promoteToPermanent = params.db.prepare(
    `UPDATE chunks SET grade = 'permanent', updated_at = ?
     WHERE grade = 'recurring'
       AND COALESCE(recall_count, 0) >= 10
       AND COALESCE(useful_count, 0) >= 1`,
  );
  const r2 = promoteToPermanent.run(now);
  promoted += Number(r2.changes);

  // --- Demotion ---

  // recurring → ephemeral (stale + never useful)
  const demoteToEphemeral = params.db.prepare(
    `UPDATE chunks SET grade = 'ephemeral', updated_at = ?
     WHERE grade = 'recurring'
       AND (last_recalled_at IS NULL OR last_recalled_at < ?)
       AND COALESCE(useful_count, 0) = 0`,
  );
  const r3 = demoteToEphemeral.run(now, sixtyDaysAgo);
  demoted += Number(r3.changes);

  // ephemeral → soft-delete (stale + barely recalled)
  const softDelete = params.db.prepare(
    `UPDATE memory_stats SET deleted_at = ?, updated_at = ?
     WHERE content_hash IN (
       SELECT content_hash FROM chunks
       WHERE grade = 'ephemeral'
         AND content_hash IS NOT NULL
         AND (last_recalled_at IS NULL OR last_recalled_at < ?)
         AND COALESCE(recall_count, 0) <= 1
     )
     AND deleted_at IS NULL`,
  );
  const r4 = softDelete.run(now, now, thirtyDaysAgo);
  softDeleted += Number(r4.changes);

  // Also mark the chunks themselves (grade → 'deleted')
  const markDeleted = params.db.prepare(
    `UPDATE chunks SET grade = 'deleted', updated_at = ?
     WHERE grade = 'ephemeral'
       AND (last_recalled_at IS NULL OR last_recalled_at < ?)
       AND COALESCE(recall_count, 0) <= 1`,
  );
  markDeleted.run(now, thirtyDaysAgo);

  // --- Sync memory_stats grades from chunks (upsert to ensure rows exist) ---
  const chunksWithHash = params.db
    .prepare(
      `SELECT content_hash, grade, recall_count, useful_count, last_recalled_at
       FROM chunks WHERE content_hash IS NOT NULL AND grade IS NOT NULL AND grade != 'deleted'`,
    )
    .all() as Array<{
    content_hash: string;
    grade: string;
    recall_count: number | null;
    useful_count: number | null;
    last_recalled_at: number | null;
  }>;
  const upsertStats = params.db.prepare(
    `INSERT INTO memory_stats (content_hash, grade, recall_count, useful_count, last_recalled_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(content_hash) DO UPDATE SET
       grade = excluded.grade,
       recall_count = MAX(memory_stats.recall_count, excluded.recall_count),
       useful_count = MAX(memory_stats.useful_count, excluded.useful_count),
       last_recalled_at = COALESCE(excluded.last_recalled_at, memory_stats.last_recalled_at),
       updated_at = excluded.updated_at
     WHERE memory_stats.deleted_at IS NULL`,
  );
  for (const row of chunksWithHash) {
    upsertStats.run(
      row.content_hash,
      row.grade,
      row.recall_count ?? 0,
      row.useful_count ?? 0,
      row.last_recalled_at,
      now,
    );
  }

  // frontmatter sync removed: DB is source of truth for grade

  return { promoted, demoted, softDeleted };
}

// syncGradeToFrontmatter removed: DB is source of truth for grade.
// File frontmatter is not modified by lifecycle.
