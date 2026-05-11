// Minimal 5-field cron -> "next fire" (epoch ms), evaluated in local time.
// Supports `*`, single values, `a-b` ranges, `a,b,c` lists, and `*/n` steps in
// any field. Day-of-month / day-of-week use the usual cron OR semantics when
// both are restricted. Good enough for the simple schedules this tool uses
// (e.g. "0 10 * * 1-5"); it is NOT a full cron implementation.

function expandField(field, min, max) {
  if (field === '*' || field === '?') {
    const out = [];
    for (let i = min; i <= max; i++) out.push(i);
    return out;
  }
  const set = new Set();
  for (const part of String(field).split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) continue;
    let lo;
    let hi;
    if (m[1] === '*') {
      lo = min;
      hi = max;
    } else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(m[1]);
      hi = lo;
    }
    const step = m[2] ? Number(m[2]) : 1;
    for (let i = lo; i <= hi; i += step) {
      if (i >= min && i <= max) set.add(i);
    }
  }
  return [...set].sort((a, b) => a - b);
}

export function parseCron(expr) {
  if (typeof expr !== 'string') return null;
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  return {
    minute: new Set(expandField(f[0], 0, 59)),
    hour: new Set(expandField(f[1], 0, 23)),
    dom: new Set(expandField(f[2], 1, 31)),
    month: new Set(expandField(f[3], 1, 12)),
    dow: new Set(expandField(f[4], 0, 6)), // 0 = Sunday
    domStar: f[2] === '*' || f[2] === '?',
    dowStar: f[4] === '*' || f[4] === '?',
  };
}

export function nextFireFromCron(expr, fromMs) {
  const c = parseCron(expr);
  if (!c) return null;
  const cur = new Date(typeof fromMs === 'number' ? fromMs : Date.now());
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1); // strictly after "now"
  // Walk minute by minute up to ~3 weeks ahead.
  for (let i = 0; i < 60 * 24 * 21; i++) {
    const domOk = c.dom.has(cur.getDate());
    const dowOk = c.dow.has(cur.getDay());
    let dayOk;
    if (c.domStar && c.dowStar) dayOk = true;
    else if (c.domStar) dayOk = dowOk;
    else if (c.dowStar) dayOk = domOk;
    else dayOk = domOk || dowOk; // both restricted -> OR
    if (
      c.minute.has(cur.getMinutes()) &&
      c.hour.has(cur.getHours()) &&
      c.month.has(cur.getMonth() + 1) &&
      dayOk
    ) {
      return cur.getTime();
    }
    cur.setMinutes(cur.getMinutes() + 1);
  }
  return null;
}
