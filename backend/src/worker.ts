import { Worker, Job } from "bullmq";
import { connection, EMAIL_QUEUE_NAME, emailQueue } from "./queue";
import { getTransporter } from "./mailer";
import { pool } from "./db";
import { tryConsumeSlot } from "./rateLimiter";

const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 5);
const MIN_DELAY_MS_BETWEEN_SENDS = Number(
  process.env.MIN_DELAY_MS_BETWEEN_SENDS || 2000
);

export function startWorker() {
  const worker = new Worker(
    EMAIL_QUEUE_NAME,
    async (job: Job, token?: string) => {
      const { emailId, sender, to, subject, body } = job.data;

      // 1. Rate limit check (Redis-backed, safe across instances)
      const slot = await tryConsumeSlot(sender || "default");
      if (!slot.allowed) {
        // Do NOT drop or fail the job. Reschedule into the next hour
        // window, preserving order as much as BullMQ's delay queue allows.
        await job.moveToDelayed(Date.now() + slot.msUntilNextWindow + 1000, token);
        throw new Error("RATE_LIMIT_RESCHEDULED"); // BullMQ treats moveToDelayed+throw as "not completed yet"
      }

      // 2. Actually send via Ethereal
      const transporter = await getTransporter();
      await transporter.sendMail({
        from: `${sender}@example.com`,
        to,
        subject,
        text: body,
      });

      // 3. Persist final state
      await pool.query(
        `UPDATE emails SET status = 'sent', sent_at = now() WHERE id = $1`,
        [emailId]
      );

      return { sent: true };
    },
    {
      connection,
      concurrency: WORKER_CONCURRENCY,
      // Enforces a minimum delay between sends globally (mimics provider
      // throttling). Documented trade-off: this is a *global* pacing limit,
      // not per-sender: see README.
      limiter: {
        max: 1,
        duration: MIN_DELAY_MS_BETWEEN_SENDS,
      },
    }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    if (err.message === "RATE_LIMIT_RESCHEDULED") {
      console.log(`[worker] job ${job.id} rescheduled due to rate limit`);
      return; // expected control-flow, not a real failure
    }
    console.error(`[worker] job ${job.id} failed:`, err.message);
    if (job.attemptsMade >= (job.opts.attempts || 1)) {
      await pool.query(
        `UPDATE emails SET status = 'failed', error = $2 WHERE id = $1`,
        [job.data.emailId, err.message]
      );
    }
  });

  return worker;
}

// Exported for potential external inspection/testing
export { emailQueue };
