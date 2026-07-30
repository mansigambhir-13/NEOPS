/**
 * Minimal 5-field cron matcher — zero deps, no surprises.
 *
 *   ┌ minute (0-59)   ┌ hour (0-23)   ┌ day-of-month (1-31)
 *   │      │      │      ┌ month (1-12)   ┌ day-of-week (0-6, 0=Sunday)
 *   *      *      *      *      *
 *
 * Supports: `*`, numbers, comma lists, ranges `a-b`, steps `*​/n` and `a-b/n`.
 * Standard cron quirk preserved: when BOTH dom and dow are restricted, either
 * matching fires (that is how vixie cron behaves and what people expect).
 */

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(field: string, min: number, max: number, where: string): { set: Set<number>; restricted: boolean } {
  const set = new Set<number>();
  if (field === "*") {
    for (let i = min; i <= max; i++) set.add(i);
    return { set, restricted: false };
  }
  for (const part of field.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad cron ${where} field: "${part}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`bad cron step in ${where}: "${part}"`);
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1]!.split("-").map(Number);
      lo = a!;
      hi = b ?? (m[2] ? max : a!); // "5/10" = every 10 starting at 5; plain "5" = just 5
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron ${where} out of range: "${part}" (${min}-${max})`);
    for (let i = lo; i <= hi; i += step) set.add(i);
  }
  return { set, restricted: true };
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron "${expr}" must have 5 fields (minute hour dom month dow)`);
  const minute = parseField(fields[0]!, 0, 59, "minute");
  const hour = parseField(fields[1]!, 0, 23, "hour");
  const dom = parseField(fields[2]!, 1, 31, "day-of-month");
  const month = parseField(fields[3]!, 1, 12, "month");
  const dow = parseField(fields[4]!, 0, 6, "day-of-week");
  return {
    minute: minute.set,
    hour: hour.set,
    dom: dom.set,
    month: month.set,
    dow: dow.set,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
}

/** Does this spec match the given local time (to the minute)? */
export function cronMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getMinutes())) return false;
  if (!spec.hour.has(d.getHours())) return false;
  if (!spec.month.has(d.getMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getDate());
  const dowOk = spec.dow.has(d.getDay());
  // vixie rule: both restricted → OR; otherwise AND (an unrestricted field is always true)
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}
