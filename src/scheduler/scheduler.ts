/**
 * The scheduler — cron for task contracts, deliberately boring.
 *
 * - fires each job at most ONCE per matching minute (keyed by minute, restart-safe
 *   enough for V1: a restart inside the same minute may refire; runs are guarded
 *   by the breaker + daily cap + idempotency keys downstream, so a refire is a
 *   dropped admission, not a duplicate action)
 * - misfire policy: SKIP, never catch up. A 3am summary at 11am is noise.
 * - a job whose fire() throws is LOGGED and left alone — the circuit breaker and
 *   the daily cap refusing a run is the system working, not a scheduler error
 * - OFF by default (NEOP_SCHEDULER=1): the Phase-0 discipline is manual runs
 *   first; unattended cron is something an operator turns on, on purpose.
 */

import { cronMatches, parseCron, type CronSpec } from "./cron.js";

export interface ScheduledJob {
  id: string;
  cron: string;
  fire: () => Promise<unknown>;
}

interface Armed {
  job: ScheduledJob;
  spec: CronSpec;
}

export class Scheduler {
  private readonly armed: Armed[] = [];
  private readonly lastFired = new Map<string, string>(); // job id → minute key
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly problems: string[] = [];

  constructor(
    jobs: ScheduledJob[],
    private readonly now: () => Date = () => new Date(),
    private readonly log: (m: string) => void = (m) => console.log(m),
  ) {
    for (const job of jobs) {
      try {
        this.armed.push({ job, spec: parseCron(job.cron) });
      } catch (e) {
        // a bad schedule never takes the plane down — it is reported and skipped
        this.problems.push(`schedule for "${job.id}": ${(e as Error).message}`);
      }
    }
  }

  get jobCount(): number {
    return this.armed.length;
  }

  /** One evaluation pass. Exposed for tests; start() calls it on an interval. */
  async tick(): Promise<string[]> {
    const d = this.now();
    const minuteKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}T${d.getHours()}:${d.getMinutes()}`;
    const fired: string[] = [];
    for (const { job, spec } of this.armed) {
      if (!cronMatches(spec, d)) continue;
      if (this.lastFired.get(job.id) === minuteKey) continue; // once per minute
      this.lastFired.set(job.id, minuteKey);
      fired.push(job.id);
      try {
        await job.fire();
        this.log(`[scheduler] fired ${job.id} (${job.cron})`);
      } catch (e) {
        // breaker open / cap reached / task error — the guardrails speaking
        this.log(`[scheduler] ${job.id} refused: ${(e as Error).message}`);
      }
    }
    return fired;
  }

  start(intervalMs = 20_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.(); // never keep the process alive just to wait for cron
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
