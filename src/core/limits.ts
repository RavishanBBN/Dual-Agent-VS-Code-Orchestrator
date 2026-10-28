/**
 * Remembers which agent reported a usage limit and when it can be tried again, so later stages go straight
 * to the other agent instead of failing first, and a stopped run knows when to continue.
 */
import type { AgentId, QuotaReading } from './types.js';

export interface AgentLimit {
  agent: AgentId;
  /** When the limit is expected to reset. */
  until: string;
  /** True when the provider gave no reset time, so `until` is only when to try again. */
  estimated: boolean;
  /** The provider's message, for the user. */
  reason: string;
  /** Consecutive limits without a successful call, which lengthens the next estimate. */
  strikes: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** When the provider says nothing about the reset: try again after 15 minutes, then 30, 60, and 120. */
const RETRY_MS = [15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR];
/** Weekly limits are the longest providers have; a reset further out than this is not trusted. */
const LONGEST_WAIT_MS = 8 * 24 * HOUR;
/** A usage window this full is treated as reached, so the other agent takes over before a call fails. */
export const NEARLY_EXHAUSTED = 98;

const UNITS: Record<string, number> = { d: 24 * HOUR, h: HOUR, m: MINUTE, s: 1_000 };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Sums a duration such as "2 hours 13 minutes", "4h 12m", or "1 day, 3 hours and 5 minutes". */
function duration(text: string): number | undefined {
  let total = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b/gi)) {
    total += Number(match[1]) * (UNITS[(match[2] ?? '').charAt(0).toLowerCase()] ?? 0);
  }
  return total > 0 ? total : undefined;
}

/** The next time the local clock shows `hours:minutes`, today or tomorrow. */
function nextClockTime(now: Date, hours: number, minutes: number): Date {
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * Reads when a usage limit resets from a provider's error message: a Unix timestamp ("limit reached|1767225600"),
 * an ISO time, a duration ("try again in 2 hours 13 minutes"), or a clock time ("resets 3pm", "resets at 15:30").
 * Returns undefined when the message names no usable time.
 */
export function parseLimitReset(message: string, now: Date): Date | undefined {
  const plausible = (at: Date): Date | undefined =>
    Number.isFinite(at.getTime()) && at.getTime() > now.getTime() && at.getTime() - now.getTime() <= LONGEST_WAIT_MS ? at : undefined;

  const epoch = /(?:\||\breset[\w"' ]*?[:=]\s*)(\d{10})\b/i.exec(message)?.[1];
  if (epoch) return plausible(new Date(Number(epoch) * 1_000));

  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(message)?.[1];
  if (iso) return plausible(new Date(iso));

  const relative = /\b(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b[\s,]*(?:and\s+)?)+)/i.exec(message)?.[1];
  const wait = relative ? duration(relative) : undefined;
  if (wait) return plausible(new Date(now.getTime() + wait));

  // Weekly limits name a date: "try again at Oct 30th, 2026 5:51 PM", "resets Nov 3, 9am".
  const dated =
    /\b(?:resets?|reset at|try again at|available at|until)\s+(?:at\s+|on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?,?(?:\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?)?/i.exec(
      message,
    );
  if (dated) {
    const month = MONTHS.indexOf((dated[1] ?? '').toLowerCase());
    const hour = dated[4] ? (Number(dated[4]) % 12) + ((dated[6] ?? '').toLowerCase() === 'p' ? 12 : 0) : 0;
    const at = new Date(Number(dated[3] ?? now.getFullYear()), month, Number(dated[2]), hour, Number(dated[5] ?? 0), 0, 0);
    // Without a year, a date already past this year means next year.
    if (!dated[3] && at.getTime() <= now.getTime()) at.setFullYear(at.getFullYear() + 1);
    return plausible(at);
  }

  const twelve = /\b(?:resets?|reset at|try again at|available at|until)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i.exec(message);
  if (twelve) {
    const hour = Number(twelve[1]) % 12 + ((twelve[3] ?? '').toLowerCase() === 'p' ? 12 : 0);
    return plausible(nextClockTime(now, hour, Number(twelve[2] ?? 0)));
  }
  const clock = /\b(?:resets?|reset at|try again at|available at|until)\s+(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/i.exec(message);
  if (clock) return plausible(nextClockTime(now, Number(clock[1]), Number(clock[2])));
  return undefined;
}

export class AgentLimits {
  private readonly limits = new Map<AgentId, AgentLimit>();
  private readonly listeners = new Set<() => void>();

  public constructor(
    initial: readonly AgentLimit[] = [],
    private readonly clock: () => number = Date.now,
  ) {
    for (const limit of initial) if (isLimit(limit)) this.limits.set(limit.agent, { ...limit });
  }

  /** The agent's limit while it is in force; an expired limit is kept only to lengthen the next estimate. */
  public active(agent: AgentId): AgentLimit | undefined {
    const limit = this.limits.get(agent);
    return limit && Date.parse(limit.until) > this.clock() ? limit : undefined;
  }

  /** Limits in force, earliest reset first. */
  public all(): AgentLimit[] {
    return (['claude', 'codex'] as const)
      .map((agent) => this.active(agent))
      .filter((limit): limit is AgentLimit => limit !== undefined)
      .sort((a, b) => a.until.localeCompare(b.until));
  }

  /** Both agents are at their limits, so nothing can run until the earlier one resets. */
  public get exhausted(): boolean {
    return this.active('claude') !== undefined && this.active('codex') !== undefined;
  }

  /** When the first of the limited agents can be tried again, if both are limited. */
  public nextReset(): Date | undefined {
    if (!this.exhausted) return undefined;
    const [first] = this.all();
    return first ? new Date(first.until) : undefined;
  }

  /** Records that `agent` reported a usage limit, with its reset time read from `reason` when it has one. */
  public record(agent: AgentId, reason: string): AgentLimit {
    const now = new Date(this.clock());
    const strikes = (this.limits.get(agent)?.strikes ?? 0) + 1;
    const reset = parseLimitReset(reason, now);
    const retry = RETRY_MS[Math.min(strikes, RETRY_MS.length) - 1] ?? HOUR;
    const limit: AgentLimit = {
      agent,
      until: (reset ?? new Date(now.getTime() + retry)).toISOString(),
      estimated: reset === undefined,
      reason: reason.slice(0, 500),
      strikes,
    };
    this.limits.set(agent, limit);
    this.changed();
    return limit;
  }

  /**
   * Records a limit from what a provider reported about its account: a limit already reached, or a window
   * all but used up, until that window resets. A reading taken outside Dual Agent counts the same way.
   */
  public observe(reading: QuotaReading): AgentLimit | undefined {
    if (this.active(reading.agent)) return undefined;
    const exhausted = reading.windows
      .filter((window) => window.usedPercent >= NEARLY_EXHAUSTED && window.resetsAt)
      .map((window) => window.resetsAt as string)
      .sort()
      .at(-1);
    const until = reading.limited ? (reading.resetsAt ?? exhausted) : exhausted;
    if (!until || Date.parse(until) <= this.clock()) return undefined;
    return this.record(reading.agent, `Usage limit ${reading.limited ? 'reached' : 'nearly reached'}; it resets at ${until}.`);
  }

  /** The agent completed a call, so whatever limit it had has reset. */
  public clear(agent: AgentId): void {
    if (this.limits.delete(agent)) this.changed();
  }

  /** Every recorded limit, including expired ones, for saving. */
  public toJSON(): AgentLimit[] {
    return [...this.limits.values()];
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

function isLimit(value: unknown): value is AgentLimit {
  const limit = value as Partial<AgentLimit> | null;
  return (
    typeof limit === 'object' &&
    limit !== null &&
    (limit.agent === 'claude' || limit.agent === 'codex') &&
    typeof limit.until === 'string' &&
    Number.isFinite(Date.parse(limit.until)) &&
    typeof limit.reason === 'string' &&
    typeof limit.strikes === 'number'
  );
}

/** "3:05 PM", or "Mon 9:00 AM" when the reset is not today. */
export function formatReset(until: string | Date, now: Date = new Date()): string {
  const at = new Date(until);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
