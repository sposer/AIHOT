// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { groupArticle } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { BudgetExceededError, ReceiptBusyError } from "../providers/receipts.ts";
import { settleNonEditorial } from "./content.ts";
import { ensureQueue, enqueue, QUEUES } from "./queue.ts";

export async function registerEventJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.group);
  // Serial on purpose: two reports of the same new fact must not both create it.
  await boss.work<{ articleId: string; force?: boolean }>(QUEUES.group, { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, async ([job]) => {
    if (!job) return;
    try {
      // decision: route by the current source mode; not a queued signalOnly hint because a source
      // promoted to editorial must group its new judgement even when its old job is still queued.
      const nonEditorial = await settleNonEditorial(job.data.articleId);
      if (nonEditorial.settled && !job.data.force && !nonEditorial.group) return { verdict: "skipped" };
      const result = await groupArticle(job.data.articleId, { force: job.data.force });
      if (result.storyId && !result.verdict.startsWith("signal")) {
        await enqueue(QUEUES.digest, { storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
      }
      return result;
    } catch (error) {
      if (error instanceof BudgetExceededError || error instanceof ReceiptBusyError) throw error;
      throw error;
    }
  });
  await ensureQueue(QUEUES.digest);
  await boss.work<{ storyId: number; afterCorrection?: boolean }>(QUEUES.digest, { localConcurrency: 3, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    return composeStoryDigest(job.data.storyId, { afterCorrection: job.data.afterCorrection });
  });
}
