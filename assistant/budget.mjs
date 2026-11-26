// Daily Workers AI budget, checked before every inference call (threat model #9).
// Default 8,000 Neurons = 80% of the 10,000/day free allocation; on Free, Cloudflare blocks (not bills) above that.
export const DEFAULT_DAILY_NEURONS = 8000;

const today = now => new Date(now()).toISOString().slice(0, 10);

/** Atomically reserve `neurons` for today. Returns false (never throws) when the reservation would exceed the limit. */
export async function reserveNeurons(db, neurons, { limit = DEFAULT_DAILY_NEURONS, now = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(neurons) || neurons <= 0 || neurons > limit) return false;
  const day = today(now);
  const prior = await db.prepare('SELECT neurons FROM assistant_usage WHERE day = ?').bind(day).first();
  const used = prior?.neurons ?? 0;
  if (used + neurons > limit) return false;
  await db.prepare(
    'INSERT INTO assistant_usage(day, neurons) VALUES (?, ?) ' +
    'ON CONFLICT(day) DO UPDATE SET neurons = neurons + excluded.neurons'
  ).bind(day, neurons).run();
  return true;
}

export async function usedNeurons(db, { now = () => Date.now() } = {}) {
  const row = await db.prepare('SELECT neurons FROM assistant_usage WHERE day = ?').bind(today(now)).first();
  return row?.neurons ?? 0;
}
