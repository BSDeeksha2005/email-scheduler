import "dotenv/config";
import express from "express";
import cors from "cors";
import { pool, initDb } from "./db";
import { scheduleEmailJob } from "./queue";
import { startWorker } from "./worker";
import emailsRouter from "./routes/emails";

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api/emails", emailsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Re-adds every still-"scheduled" DB row as a BullMQ delayed job on boot.
 *
 * Why this is safe (no duplicates): scheduleEmailJob() always uses the
 * DB row's id as the BullMQ jobId. BullMQ refuses to create a second
 * job with a jobId that's already waiting/delayed/active in the queue,
 * so calling this on every restart is idempotent — whether the previous
 * jobs are still sitting safely in Redis (common case) or Redis itself
 * was flushed (edge case), the result is the same: every "scheduled"
 * email in the DB ends up with exactly one live job, at the correct
 * (or immediately-due, if the time has already passed) fire time.
 */
async function rehydrateScheduledJobs() {
  const { rows } = await pool.query(
    `SELECT id, sender, to_email, subject, body, scheduled_at
     FROM emails WHERE status = 'scheduled'`
  );

  for (const row of rows) {
    await scheduleEmailJob({
      id: row.id,
      sender: row.sender,
      to: row.to_email,
      subject: row.subject,
      body: row.body,
      scheduledAt: new Date(row.scheduled_at),
    });
  }

  console.log(`[boot] rehydrated ${rows.length} scheduled job(s) from DB`);
}

async function main() {
  await initDb();
  await rehydrateScheduledJobs();
  startWorker();

  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => console.log(`[boot] listening on :${port}`));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
