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

  // ephemeral → recurring
  const promoteToRecurring = params.db.prepare(
    `UPDATE chunks SET grade = 'recurring', updated_at = ?
     WHERE grade = 'ephemeral'
       AND COALESCE(recall_count, 0) >= 3
       AND COALESCE(useful_count, 0) >= 1`,
  );
  const r1 = promoteToRecurring.run(now);
  promoted += Number(r1.changes);

  // recurring → permanent
  const promoteToPermanent = params.db.prepare(
    `UPDATE chunks SET grade = 'permanent', updated_at = ?
     WHERE grade = 'recurring'
       AND COALESCE(recall_count, 0) >= 10
       AND COALESCE(useful_count, 0) >= 5`,
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

  // --- Sync memory_stats grades from chunks ---
  params.db.exec(`
    UPDATE memory_stats SET grade = (
      SELECT c.grade FROM chunks c
      WHERE c.content_hash = memory_stats.content_hash
        AND c.content_hash IS NOT NULL
      LIMIT 1
    ), updated_at = ${now}
    WHERE content_hash IN (
      SELECT content_hash FROM chunks WHERE content_hash IS NOT NULL
    )
    AND deleted_at IS NULL
  `);

  return { promoted, demoted, softDeleted };
}
