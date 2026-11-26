// Daily Workers AI budget, checked before every inference call (threat model #9).
// Default 8,000 Neurons = 80% of the 10,000/day free allocation; on Free, Cloudflare blocks (not bills) above that.
export const DEFAULT_DAILY_NEURONS = 8000;

const today = now => new Date(now()).toISOString().slice(0, 10);

/** Atomically reserve `neurons` for today. Returns false (never throws) when the reservation would exceed the limit. */
export async function reserveNeurons(db, neurons, { limit = DEFAULT_DAILY_NEURONS, now = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(neurons) || neurons <= 0 || neurons > limit) return false;
  const row = await db.prepare(
    'INSERT INTO assistant_usage(day, neurons) VALUES (?1, ?2) ' +
    'ON CONFLICT(day) DO UPDATE SET neurons = neurons + ?2 WHERE neurons + ?2 <= ?3 RETURNING neurons'
  ).bind(today(now), neurons, limit).first();
  return Boolean(row);
}

export async function usedNeurons(db, { now = () => Date.now() } = {}) {
  const row = await db.prepare('SELECT neurons FROM assistant_usage WHERE day = ?1').bind(today(now)).first();
  return row?.neurons ?? 0;
}
