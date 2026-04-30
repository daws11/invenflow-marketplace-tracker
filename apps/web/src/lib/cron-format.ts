// Tiny human-readable cron formatter for the schedule presets the sidecar
// actually uses (PRD §7.4 — cron is fixed to 5-field, Asia/Jakarta).
//
// We don't pull in `cronstrue` etc. because the only patterns we care about
// are the ones presented in the form ("Daily", "Weekdays", "Weekends",
// "Custom"). Anything outside those, the table falls back to showing the
// raw cron string.

export type SchedulePreset = 'daily' | 'weekdays' | 'weekends' | 'custom';

export interface ScheduleParts {
  preset: SchedulePreset;
  /** 0–23, only meaningful for non-`custom`. */
  hour: number;
  /** 0–59, only meaningful for non-`custom`. */
  minute: number;
}

const HOUR_RE = /^(?:[0-9]|1[0-9]|2[0-3])$/;
const MIN_RE = /^(?:[0-9]|[1-5][0-9])$/;

/**
 * Parse a 5-field cron expression back into `{ preset, hour, minute }`.
 * Recognises the three preset day patterns; everything else returns `custom`.
 * Returns `null` only on totally-malformed input (so callers can distinguish
 * "we don't know the preset" from "this isn't even cron").
 */
export function parseCron(expr: string | null | undefined): ScheduleParts | null {
  if (!expr) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts;
  if (!MIN_RE.test(m) || !HOUR_RE.test(h)) {
    return { preset: 'custom', hour: 0, minute: 0 };
  }
  if (dom !== '*' || mon !== '*') {
    return { preset: 'custom', hour: Number(h), minute: Number(m) };
  }
  let preset: SchedulePreset;
  if (dow === '*') preset = 'daily';
  else if (dow === '1-5') preset = 'weekdays';
  else if (dow === '0,6' || dow === '6,0') preset = 'weekends';
  else preset = 'custom';
  return { preset, hour: Number(h), minute: Number(m) };
}

/** Build the canonical cron expression for a preset + time. */
export function buildCron(parts: Omit<ScheduleParts, 'preset'> & { preset: Exclude<SchedulePreset, 'custom'> }): string {
  const { preset, hour, minute } = parts;
  const m = String(minute);
  const h = String(hour);
  switch (preset) {
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'weekends':
      return `${m} ${h} * * 0,6`;
  }
}

const PRESET_LABEL: Record<SchedulePreset, string> = {
  daily: 'Setiap hari',
  weekdays: 'Senin–Jumat',
  weekends: 'Sabtu–Minggu',
  custom: 'Custom',
};

/**
 * Render a schedule for table display. Falls back to the raw cron string
 * when the pattern doesn't match a preset, so we never lose information.
 */
export function cronToHuman(expr: string | null | undefined): string {
  if (!expr) return '—';
  const parsed = parseCron(expr);
  if (!parsed) return expr;
  if (parsed.preset === 'custom') return expr;
  const time = `${pad(parsed.hour)}:${pad(parsed.minute)}`;
  return `${PRESET_LABEL[parsed.preset]} · ${time}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Pretty time-of-day, used by the preview helper in the form. */
export function formatTime(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}
