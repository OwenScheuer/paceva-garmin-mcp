/**
 * Garmin's responses carry minute-by-minute series (heart rate, stress, Body
 * Battery, sleep stages) that run to thousands of numbers. An AI app only
 * needs those when someone asks about the shape of a day, so by default each
 * long series is replaced with its count and range. Empty fields and account
 * plumbing are dropped. Everything else passes through untouched.
 */

/** Keys Garmin uses for time series. */
const SERIES_KEY = /(Values|ValuesArray|Levels|Movement|Readings|Descriptors|Samples|Points)$/i;
/**
 * Account plumbing that helps no answer: internal IDs, the owner's name and
 * profile photos. Dropped so they aren't sent to the AI provider for nothing.
 */
const DROP_KEY =
  /^(uuid|activityUUID|userProfilePk|userProfilePK|userProfileId|ownerId|ownerDisplayName|ownerFullName|ownerProfileImageUrl\w*|deviceId|hasImages|hasVideo|privacy)$/;

/** A series longer than this is summarized. */
const SERIES_MAX = 24;
/** Any array longer than this is summarized, series key or not. */
const ARRAY_MAX = 200;

export type CompactOptions = { includeSeries?: boolean };

export function compact(value: unknown, opts: CompactOptions = {}, key = ""): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const long = value.length > ARRAY_MAX || (SERIES_KEY.test(key) && value.length > SERIES_MAX);
    if (long && !opts.includeSeries) return summarizeSeries(value);
    const items = value.map((v) => compact(v, opts)).filter((v) => v !== undefined);
    return items.length ? items : undefined;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEY.test(k)) continue;
      const c = compact(v, opts, k);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

/** Count and range of a series; for [timestamp, value, …] rows, of the value column. */
export function summarizeSeries(series: unknown[]): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    omitted: `${series.length} readings; ask again with include_series to see them`,
  };
  const values = series
    .map((row) => (Array.isArray(row) ? row[1] : typeof row === "number" ? row : undefined))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (values.length) {
    summary.min = Math.min(...values);
    summary.max = Math.max(...values);
    summary.avg = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
  }
  return summary;
}
