import { Queue } from "bullmq";
import IORedis from "ioredis";

export const connection = new IORedis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null, // required by BullMQ
});

export const EMAIL_QUEUE_NAME = "email-send";

export const emailQueue = new Queue(EMAIL_QUEUE_NAME, { connection });

/**
 * Schedule (or re-schedule) an email job.
 * Uses the DB row's id as the BullMQ jobId. This is the core of our
 * idempotency guarantee: BullMQ will not create a second job with the
 * same jobId while one already exists (waiting/delayed/active), so
 * re-adding on every server restart during rehydration is always safe
 * and never produces a duplicate send.
 */
export async function scheduleEmailJob(params: {
  id: string;
  sender: string;
  to: string;
  subject: string;
  body: string;
  scheduledAt: Date;
}) {
  const delay = Math.max(0, params.scheduledAt.getTime() - Date.now());

  await emailQueue.add(
    "send-email",
    {
      emailId: params.id,
      sender: params.sender,
      to: params.to,
      subject: params.subject,
      body: params.body,
    },
    {
      jobId: params.id, // idempotency key
      delay,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    }
  );
}
