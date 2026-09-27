import { connection } from "./queue";

const MAX_EMAILS_PER_HOUR = Number(process.env.MAX_EMAILS_PER_HOUR || 200);

function hourWindowKey(sender: string, date = new Date()) {
  // Truncate to the hour, e.g. 2026-09-27T14
  const bucket = date.toISOString().slice(0, 13);
  return `rate:${sender}:${bucket}`;
}

/**
 * Atomically increments the counter for this sender's current hour window
 * and reports whether the send is still allowed.
 *
 * Backed by Redis (INCR + EXPIRE), not an in-memory counter, so this is
 * safe across multiple worker processes/instances sharing the same Redis.
 */
export async function tryConsumeSlot(sender: string): Promise<{
  allowed: boolean;
  count: number;
  msUntilNextWindow: number;
}> {
  const key = hourWindowKey(sender);
  const count = await connection.incr(key);
  if (count === 1) {
    // first hit this hour window - set expiry so keys don't accumulate forever
    await connection.expire(key, 3600 * 2);
  }

  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(0, 0, 0);
  nextHour.setUTCHours(nextHour.getUTCHours() + 1);
  const msUntilNextWindow = nextHour.getTime() - now.getTime();

  if (count > MAX_EMAILS_PER_HOUR) {
    // Over budget: undo our increment attempt's effect isn't necessary since
    // we still want the count to reflect demand, but we must NOT send now.
    return { allowed: false, count, msUntilNextWindow };
  }

  return { allowed: true, count, msUntilNextWindow };
}
