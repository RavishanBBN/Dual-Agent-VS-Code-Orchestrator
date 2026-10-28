/**
 * Continues runs that stopped at the agents' usage limits once the limits reset. Pending continuations are
 * saved, so they survive a restart of VS Code; one that came due while VS Code was closed runs soon after start.
 */

export interface Continuation {
  runId: string;
  /** When to continue: shortly after the first limit resets. */
  at: string;
  /**
   * The setup and verification commands when the run stopped. A run that edits files continues on its own
   * only with the same commands it was allowed to run; otherwise it waits for the user.
   */
  commands: string;
}

/** What firing a continuation did: finished with it, or try again shortly because another run is active. */
export type ContinuationOutcome = 'done' | 'retry';

/** Margin after the reset, so the provider has certainly reset the limit. */
export const CONTINUE_MARGIN_MS = 60_000;
const RETRY_MS = 60_000;
/** Due continuations wait this long after start, so VS Code finishes loading first. */
const STARTUP_DELAY_MS = 5_000;
/** The longest delay a timer accepts. */
const LONGEST_TIMER_MS = 2_147_483_647;

/** When to continue a run whose first limit resets at `reset`. */
export function continueAt(reset: string): string {
  return new Date(Date.parse(reset) + CONTINUE_MARGIN_MS).toISOString();
}

function isContinuation(value: unknown): value is Continuation {
  const item = value as Partial<Continuation> | null;
  return typeof item === 'object' && item !== null && typeof item.runId === 'string' && typeof item.at === 'string' && Number.isFinite(Date.parse(item.at)) && typeof item.commands === 'string';
}

export class ContinuationScheduler {
  private readonly items = new Map<string, Continuation>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  public constructor(
    initial: readonly unknown[],
    private readonly save: (items: Continuation[]) => void,
    private readonly fire: (item: Continuation) => Promise<ContinuationOutcome>,
    private readonly clock: () => number = Date.now,
  ) {
    for (const item of initial) {
      if (!isContinuation(item)) continue;
      this.items.set(item.runId, { ...item });
      this.arm(item, STARTUP_DELAY_MS);
    }
  }

  public get(runId: string): Continuation | undefined {
    return this.items.get(runId);
  }

  public get size(): number {
    return this.items.size;
  }

  public schedule(item: Continuation): void {
    this.items.set(item.runId, { ...item });
    this.arm(item);
    this.changed();
  }

  public cancel(runId: string): boolean {
    const removed = this.items.delete(runId);
    this.disarm(runId);
    if (removed) this.changed();
    return removed;
  }

  /** Fires a pending continuation now instead of at its time. */
  public async runNow(runId: string): Promise<void> {
    const item = this.items.get(runId);
    if (!item) return;
    this.disarm(runId);
    await this.run(item);
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    this.disposed = true;
    for (const runId of [...this.timers.keys()]) this.disarm(runId);
  }

  private arm(item: Continuation, minimum = 1_000): void {
    this.disarm(item.runId);
    if (this.disposed) return;
    const delay = Math.min(LONGEST_TIMER_MS, Math.max(minimum, Date.parse(item.at) - this.clock()));
    this.timers.set(
      item.runId,
      setTimeout(() => {
        this.timers.delete(item.runId);
        // A timer cut short by the longest delay a timer accepts just waits again.
        if (Date.parse(item.at) - this.clock() > 1_000) this.arm(item);
        else void this.run(item);
      }, delay),
    );
  }

  private disarm(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer) clearTimeout(timer);
    this.timers.delete(runId);
  }

  private async run(item: Continuation): Promise<void> {
    const fired = this.items.get(item.runId);
    if (!fired) return;
    let outcome: ContinuationOutcome;
    try {
      outcome = await this.fire(fired);
    } catch {
      outcome = 'done';
    }
    // Cancelled meanwhile, or replaced because the continued run stopped at a limit again.
    if (this.items.get(item.runId) !== fired) return;
    if (outcome === 'retry') {
      const retry = { ...item, at: new Date(this.clock() + RETRY_MS).toISOString() };
      this.items.set(item.runId, retry);
      this.arm(retry);
    } else {
      this.items.delete(item.runId);
    }
    this.changed();
  }

  private changed(): void {
    this.save([...this.items.values()]);
    for (const listener of this.listeners) listener();
  }
}
