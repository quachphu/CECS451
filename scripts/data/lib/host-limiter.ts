/**
 * Politeness for site fetches: at most `hosts` different hosts in flight at
 * once, and at most one request per `intervalMs` to any single host.
 */
import { createLimiter, type Limit } from "../../../src/lib/limiter";
import { sleep } from "./io";

export type HostLimiter = {
  /** Runs one venue's work with a host slot held. */
  forHost<T>(host: string, fn: (wait: () => Promise<void>) => Promise<T>): Promise<T>;
};

export function createHostLimiter(hosts = 8, intervalMs = 1000, now = () => Date.now()): HostLimiter {
  const slots: Limit = createLimiter(hosts);
  const lastRequest = new Map<string, number>();
  const chains = new Map<string, Promise<unknown>>();

  /** Resolves when the next request to `host` may be sent. */
  const waitFor = (host: string) => async () => {
    const last = lastRequest.get(host);
    const delay = last == null ? 0 : last + intervalMs - now();
    if (delay > 0) await sleep(delay);
    lastRequest.set(host, now());
  };

  return {
    forHost(host, fn) {
      // Work for the same host is serialized, so its request spacing holds.
      const previous = chains.get(host) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(() => slots(() => fn(waitFor(host))));
      chains.set(host, run);
      return run;
    },
  };
}
