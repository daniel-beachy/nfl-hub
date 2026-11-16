// Runs one task over and over (plan 9.2): never two at once, paused while the tab is
// hidden, slower after each failure, and straight away when the tab comes back.

export interface PollerEnv {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  isHidden(): boolean;
  /** Calls `fn` whenever the tab is shown or hidden. Returns the unsubscribe. */
  onVisibility(fn: () => void): () => void;
}

export const browserEnv: PollerEnv = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
  isHidden: () => globalThis.document?.hidden ?? false,
  onVisibility: (fn) => {
    globalThis.document?.addEventListener("visibilitychange", fn);
    return () => globalThis.document?.removeEventListener("visibilitychange", fn);
  },
};

export const MAX_BACKOFF_MS = 120_000;

export class Poller {
  /** Failed runs in a row. */
  failures = 0;
  private timer: unknown = null;
  private running = false;
  private again = false;
  private stopped = true;
  private unsubscribe: (() => void) | null = null;
  private readonly task: () => Promise<void>;
  private readonly interval: () => number | null;
  private readonly env: PollerEnv;

  /**
   * @param task Rejects when a run failed. It must record its own error; the poller only counts.
   * @param interval Milliseconds to wait after a good run, asked after every run. `null`
   *   means stop until `runNow()` (a finished game needs no more polling).
   */
  constructor(task: () => Promise<void>, interval: () => number | null, env: PollerEnv = browserEnv) {
    this.task = task;
    this.interval = interval;
    this.env = env;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = this.env.onVisibility(() => {
      if (this.env.isHidden()) this.clear();
      else this.runNow();
    });
    if (!this.env.isHidden()) this.runNow();
  }

  stop(): void {
    this.stopped = true;
    this.again = false;
    this.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Run as soon as possible: the tab came back, or the caller changed what to fetch. */
  runNow(): void {
    if (this.stopped) return;
    this.clear();
    if (this.running) this.again = true;
    else void this.run();
  }

  private clear(): void {
    if (this.timer !== null) this.env.clearTimeout(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      await this.task();
      this.failures = 0;
    } catch {
      this.failures++;
    }
    this.running = false;
    if (this.stopped) return;
    if (this.again) {
      this.again = false;
      void this.run();
      return;
    }
    if (this.env.isHidden()) return;
    const base = this.interval();
    if (base === null && this.failures === 0) return;
    const wait = base ?? 10_000;
    // Double per failure, up to two minutes (or the normal interval if that is longer).
    const delay = this.failures === 0 ? wait : Math.min(wait * 2 ** this.failures, Math.max(wait, MAX_BACKOFF_MS));
    this.timer = this.env.setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }
}
