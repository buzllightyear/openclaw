import fs from "node:fs";
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

  // --- Sync grade changes back to md file frontmatter ---
  syncGradeToFrontmatter(params.db);

  return { promoted, demoted, softDeleted };
}

/**
 * For chunks whose grade changed (updated_at == recent), rewrite the
 * corresponding frontmatter `grade:` line in the source md file.
 */
function syncGradeToFrontmatter(db: DatabaseSync): void {
  // Get chunks that were just updated (within last 5 seconds) and have a path
  const recentlyChanged = db
    .prepare(
      `SELECT DISTINCT path, grade FROM chunks
       WHERE updated_at > ? AND path IS NOT NULL AND grade IS NOT NULL
         AND grade != 'deleted'`,
    )
    .all(Date.now() - 5000) as Array<{ path: string; grade: string }>;

  // Group by path — use the "highest" grade if multiple chunks in one file
  const gradeRank: Record<string, number> = { ephemeral: 0, recurring: 1, permanent: 2 };
  const pathGrades = new Map<string, string>();
  for (const row of recentlyChanged) {
    const current = pathGrades.get(row.path);
    if (!current || (gradeRank[row.grade] ?? 0) > (gradeRank[current] ?? 0)) {
      pathGrades.set(row.path, row.grade);
    }
  }

  for (const [filePath, grade] of pathGrades) {
    try {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      let content = fs.readFileSync(filePath, "utf-8");

      // Check if file has frontmatter
      if (content.startsWith("---")) {
        const endIdx = content.indexOf("---", 3);
        if (endIdx > 0) {
          const frontmatter = content.slice(0, endIdx + 3);
          const body = content.slice(endIdx + 3);

          if (/^grade:\s*.+$/m.test(frontmatter)) {
            // Replace existing grade line
            const updatedFm = frontmatter.replace(/^grade:\s*.+$/m, `grade: ${grade}`);
            content = updatedFm + body;
          } else {
            // Add grade line after opening ---
            content = `---\ngrade: ${grade}\n${frontmatter.slice(4)}${body}`;
          }
          fs.writeFileSync(filePath, content, "utf-8");
        }
      }
    } catch {
      // Best-effort: don't break lifecycle on file write errors
    }
  }
}
