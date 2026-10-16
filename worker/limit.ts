// The one concurrency tool for RPC work. 16 in flight is the measured safe level for the node:
// ~49 free counts/s with no errors, where an unbounded burst timed ~100 out (17 Oct).
export const SAFE_CONCURRENCY = 16;

// At most `n` tasks at once, started in arrival order. A finishing task hands its slot straight to
// the next waiter, so nothing can jump the queue between a release and a wake-up.
export function createLimiter(n = SAFE_CONCURRENCY) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function limited<T>(fn: () => Promise<T>): Promise<T> {
    if (active < n) active++;
    else await new Promise<void>((r) => waiting.push(r)); // the slot is handed over, already counted
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// fn over every item, `n` at a time, preserving order in the result.
export async function inBatches<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  n = SAFE_CONCURRENCY,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n)
    out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}
