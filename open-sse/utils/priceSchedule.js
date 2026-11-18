// Time-of-day price schedules. Windows are half-open [start, end) in UTC hours; a band is "peak" or "offpeak".
// A date missing from a holiday list counts as a workday (peak), so a stale list only over-counts cost.

const DAY = 86400000;
const HOUR = 3600000;
const SEARCH_LIMIT = 21 * DAY;

// Chinese public holidays (State Council notices), inclusive UTC date ranges. Weekend make-up working days are
// deliberately not listed: DeepSeek prices weekends off-peak "in full".
const SCHEDULES = {
  deepseek: {
    peakWindows: [[1, 4], [6, 10]],
    holidays: [
      ["2026-01-01", "2026-01-03"], ["2026-02-15", "2026-02-23"], ["2026-04-04", "2026-04-06"],
      ["2026-05-01", "2026-05-05"], ["2026-06-19", "2026-06-21"], ["2026-09-25", "2026-09-27"],
      ["2026-10-01", "2026-10-07"],
      ["2027-01-01", "2027-01-03"], ["2027-02-05", "2027-02-13"], ["2027-04-03", "2027-04-05"],
      ["2027-05-01", "2027-05-05"], ["2027-06-09", "2027-06-09"], ["2027-09-15", "2027-09-15"],
      ["2027-10-01", "2027-10-07"],
    ],
    coverage: { from: "2026-01-01", to: "2027-12-31" },
  },
};

export function hasSchedule(id) {
  return Object.prototype.hasOwnProperty.call(SCHEDULES, id);
}

const dateKey = (d) => d.toISOString().slice(0, 10);

export function bandFor(id, at) {
  if (!hasSchedule(id) || typeof at !== "number" || !Number.isFinite(at)) return "peak";
  const s = SCHEDULES[id];
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "peak";
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return "offpeak";
  const h = d.getUTCHours();
  if (!s.peakWindows.some(([a, b]) => h >= a && h < b)) return "offpeak";
  const key = dateKey(d);
  if (s.holidays.some(([a, b]) => key >= a && key <= b)) return "offpeak";
  return "peak";
}

export function nextBoundary(id, at) {
  if (!hasSchedule(id) || typeof at !== "number" || !Number.isFinite(at)) return null;
  const current = bandFor(id, at);
  const first = Math.floor(at / HOUR) * HOUR + HOUR;
  for (let t = first; t - at <= SEARCH_LIMIT; t += HOUR) {
    if (bandFor(id, t) !== current) return t;
  }
  return null;
}

export function calendarStale(id, now) {
  if (!hasSchedule(id)) return false;
  return now >= Date.parse(SCHEDULES[id].coverage.to) - 30 * DAY;
}
