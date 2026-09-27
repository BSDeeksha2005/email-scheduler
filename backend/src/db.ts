import { Pool } from "pg";

export const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "scheduler",
  password: process.env.PGPASSWORD || "scheduler",
  database: process.env.PGDATABASE || "scheduler",
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS emails (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sender TEXT NOT NULL DEFAULT 'default',
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | sent | failed
      sent_at TIMESTAMPTZ,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // gen_random_uuid() needs pgcrypto on some postgres images
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`).catch(() => {
    /* ignore if not permitted; uuid still generated app-side as fallback if needed */
  });

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
  `);
}
