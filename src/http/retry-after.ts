/**
 * The retry-after response header (RFC 9110 section 10.2.3): delta-seconds or an HTTP-date.
 * Parsed strictly: anything Date.parse would guess at is "unusable" instead.
 */

const MS_PER_SECOND = 1_000;
/** RFC 9110: an rfc850 date more than this far ahead belongs to the previous century. */
const RFC850_MAX_YEARS_AHEAD = 50;
const YEARS_PER_CENTURY = 100;
const DELTA_SECONDS = /^\d+$/;
// HTTP-date (RFC 9110 section 5.6.7): IMF-fixdate plus the two obsolete forms a recipient must
// accept. Day names are shape-checked only; the value comes from day, month, year and time.
const MONTH_GROUP = "(?<month>[A-Z][a-z]{2})";
const TIME_GROUPS = String.raw`(?<hour>\d\d):(?<minute>\d\d):(?<second>\d\d)`;
const IMF_FIXDATE = new RegExp(String.raw`^[A-Z][a-z]{2}, (?<day>\d\d) ${MONTH_GROUP} (?<year>\d{4}) ${TIME_GROUPS} GMT$`);
const RFC850_DATE = new RegExp(String.raw`^[A-Z][a-z]{5,8}, (?<day>\d\d)-${MONTH_GROUP}-(?<yy>\d\d) ${TIME_GROUPS} GMT$`);
const ASCTIME_DATE = new RegExp(String.raw`^[A-Z][a-z]{2} ${MONTH_GROUP} (?<day>[ \d]\d) ${TIME_GROUPS} (?<year>\d{4})$`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Calendar fields of an HTTP-date; `month` is 0-11, or -1 for an unknown month name. */
type DateTimeParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

/**
 * Parses retry-after (delta-seconds or HTTP-date) into a wait in ms from `nowMs`; undefined when
 * absent or unusable. A date in the past gives 0.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (DELTA_SECONDS.test(trimmed)) {
    return Number(trimmed) * MS_PER_SECOND;
  }
  const dateMs = parseHttpDateMs(trimmed, nowMs);
  return dateMs === undefined ? undefined : Math.max(0, dateMs - nowMs);
}

/** Epoch ms of an HTTP-date in any of its three forms (all UTC), or undefined. */
function parseHttpDateMs(value: string, nowMs: number): number | undefined {
  const groups = (IMF_FIXDATE.exec(value) ?? RFC850_DATE.exec(value) ?? ASCTIME_DATE.exec(value))?.groups;
  if (groups === undefined) {
    return undefined;
  }
  // Every group exists for the form that matched; Number(undefined) would be NaN and fail toEpochMs.
  const parts = {
    month: MONTHS.findIndex((name) => name === groups["month"]),
    day: Number(groups["day"]),
    hour: Number(groups["hour"]),
    minute: Number(groups["minute"]),
    second: Number(groups["second"]),
  };
  const twoDigitYear = groups["yy"];
  return twoDigitYear === undefined
    ? toEpochMs({ ...parts, year: Number(groups["year"]) })
    : rfc850EpochMs(Number(twoDigitYear), parts, nowMs);
}

/**
 * RFC 9110: a two-digit year is read as the latest matching year, except that a timestamp
 * more than 50 years in the future means the most recent past year with those digits.
 */
function rfc850EpochMs(twoDigits: number, parts: Omit<DateTimeParts, "year">, nowMs: number): number | undefined {
  const limitYear = new Date(nowMs).getUTCFullYear() + RFC850_MAX_YEARS_AHEAD;
  const limitMs = new Date(nowMs).setUTCFullYear(limitYear);
  const latestYear = limitYear - ((limitYear - twoDigits) % YEARS_PER_CENTURY);
  const latestMs = toEpochMs({ ...parts, year: latestYear });
  return latestMs !== undefined && latestMs > limitMs
    ? toEpochMs({ ...parts, year: latestYear - YEARS_PER_CENTURY })
    : latestMs;
}

/** UTC epoch ms, or undefined for an impossible date (31 Sep, 24:00). Second 60 (leap second) is allowed. */
function toEpochMs(parts: DateTimeParts): number | undefined {
  const { year, month, day, hour, minute, second } = parts;
  const midnight = new Date(Date.UTC(year, month, day));
  const isRealDay = midnight.getUTCMonth() === month && midnight.getUTCDate() === day;
  const isRealTime = hour <= 23 && minute <= 59 && second <= 60;
  if (!isRealDay || !isRealTime) {
    return undefined;
  }
  return midnight.getTime() + ((hour * 60 + minute) * 60 + second) * MS_PER_SECOND;
}
