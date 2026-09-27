import { Router } from "express";
import multer from "multer";
import { pool } from "../db";
import { scheduleEmailJob } from "../queue";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * POST /api/emails/schedule
 * body: { sender?, to, subject, body, scheduledAt (ISO string) }
 */
router.post("/schedule", async (req, res) => {
  try {
    const { sender = "default", to, subject, body, scheduledAt } = req.body;

    if (!to || !subject || !body || !scheduledAt) {
      return res.status(400).json({
        error: "to, subject, body, and scheduledAt are all required",
      });
    }

    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) {
      return res.status(400).json({ error: "scheduledAt is not a valid date" });
    }

    const result = await pool.query(
      `INSERT INTO emails (sender, to_email, subject, body, scheduled_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, sender, to_email, subject, body, scheduled_at, status, created_at`,
      [sender, to, subject, body, scheduledDate]
    );

    const row = result.rows[0];

    await scheduleEmailJob({
      id: row.id,
      sender: row.sender,
      to: row.to_email,
      subject: row.subject,
      body: row.body,
      scheduledAt: scheduledDate,
    });

    res.status(201).json(row);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/emails/scheduled
 */
router.get("/scheduled", async (_req, res) => {
  const result = await pool.query(
    `SELECT id, sender, to_email, subject, scheduled_at, status
     FROM emails WHERE status = 'scheduled' ORDER BY scheduled_at ASC`
  );
  res.json(result.rows);
});

/**
 * GET /api/emails/sent
 */
router.get("/sent", async (_req, res) => {
  const result = await pool.query(
    `SELECT id, sender, to_email, subject, sent_at, status
     FROM emails WHERE status IN ('sent', 'failed') ORDER BY sent_at DESC NULLS LAST`
  );
  res.json(result.rows);
});

/**
 * POST /api/emails/parse-leads
 * Accepts a CSV/text file of email addresses (one per line, or comma
 * separated). Returns just the count + parsed list — bulk scheduling
 * from this list is a documented trade-off left out due to time (see
 * README): wire it up to /schedule in a loop from the frontend.
 */
router.post("/parse-leads", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required" });

  const text = req.file.buffer.toString("utf-8");
  const emailRegex = /[^\s,;]+@[^\s,;]+\.[^\s,;]+/g;
  const matches = text.match(emailRegex) || [];
  const unique = Array.from(new Set(matches));

  res.json({ count: unique.length, emails: unique });
});

export default router;
