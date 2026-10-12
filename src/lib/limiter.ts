/**
 * Minimal concurrency limiter: at most `concurrency` of the functions passed
 * to the returned `limit()` run at once; the rest wait in FIFO order.
 *
 * Same pattern as p-limit (Sindre Sorhus) [C4] — a counter of active tasks and
 * a queue of starters — written out here rather than added as a dependency.
 */
export type Limit = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLimiter(concurrency: number): Limit {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("concurrency must be a positive integer");
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= concurrency) return;
    const start = queue.shift();
    if (!start) return;
    active += 1;
    start();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        // Promise.resolve().then(fn) turns a synchronous throw into a rejection.
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
}
