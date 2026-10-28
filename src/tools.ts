import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact } from "./compact.js";
import { GarminError, type GarminClient, KEY_PAGE } from "./garmin.js";

/** Longest range one call may ask for, so a question can't pull years at once. */
export const MAX_RANGE_DAYS = 92;
/** The training log is compact, so it may cover a year. */
export const MAX_LOG_DAYS = 366;
const MAX_LOG_ROWS = 1000;

/** Today's date where this computer is, as YYYY-MM-DD. */
export function today(now = new Date()): string {
  return now.toLocaleDateString("en-CA");
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Not a real date");

const day = isoDate.optional().describe("Calendar date, YYYY-MM-DD. Defaults to today.");
const start = isoDate.describe("First day, YYYY-MM-DD.");
const end = isoDate.optional().describe("Last day, YYYY-MM-DD, inclusive. Defaults to today.");
const series = z
  .boolean()
  .optional()
  .describe(
    "Include minute-by-minute series. Off by default: long series come back as count, min, max and average.",
  );

/** Resolve and check a date range, inclusive. */
export function range(startDate: string, endDate?: string, maxDays = MAX_RANGE_DAYS): [string, string] {
  const last = endDate ?? today();
  if (startDate > last) throw new GarminError(`start_date ${startDate} is after end_date ${last}.`);
  const days = (Date.parse(last) - Date.parse(startDate)) / 86_400_000 + 1;
  if (days > maxDays) {
    throw new GarminError(
      `That's ${days} days; ask for ${maxDays} or fewer at a time and split longer periods.`,
    );
  }
  return [startDate, last];
}

/** Which of the four buckets a Garmin activity type falls in. */
export function sportOf(typeKey: string): "run" | "bike" | "swim" | "other" {
  if (/swim/.test(typeKey)) return "swim";
  if (/cycl|bik|ride|spin/.test(typeKey)) return "bike";
  if (/run|trail|treadmill/.test(typeKey)) return "run";
  return "other";
}

/**
 * The fields the training log keeps from each activity in Garmin's list,
 * under Garmin's own names with Garmin's values untouched. The full record
 * runs to ~2 KB of flags and map data; this keeps a year of workouts small
 * enough to read in one go.
 */
const LOG_FIELD =
  /^(activityId|activityName|startTimeLocal|activityType|distance|duration|movingDuration|elapsedDuration|averageSpeed|maxSpeed|avgGradeAdjustedSpeed|elevationGain|elevationLoss|averageHR|maxHR|avgPower|maxPower|normPower|max20MinPower|maxFtp|trainingStressScore|intensityFactor|average(Running|Biking|Swim)Cadence\w*|averageSwolf|poolLength|activeLengths|aerobicTrainingEffect|anaerobicTrainingEffect|trainingEffectLabel|activityTrainingLoad|vO2MaxValue|calories|moderateIntensityMinutes|vigorousIntensityMinutes|totalSets|totalReps|lapCount|pr|fastestSplit_\d+|hrTimeInZone_\d|powerTimeInZone_\d|maxAvgPower_\d+)$/;

/** One activity from Garmin's list, cut to the training-log fields. */
export function logRow(a: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (!LOG_FIELD.test(k) || v === null || v === undefined || v === false) continue;
    row[k] = k === "activityType" && v && typeof v === "object" ? { typeKey: (v as { typeKey?: unknown }).typeKey } : v;
  }
  return row;
}

const typeKeyOf = (a: Record<string, unknown>) =>
  String((a.activityType as { typeKey?: string } | undefined)?.typeKey ?? "");

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown, includeSeries = false): Result {
  return text(compact(data, { includeSeries }));
}

/** Data this server already shaped, sent as is. */
function text(body: unknown): Result {
  return {
    content: [
      { type: "text", text: body === undefined ? "Garmin has no data for this." : JSON.stringify(body) },
    ],
  };
}

function fail(err: unknown): Result {
  const text =
    err instanceof GarminError
      ? err.message
      : err instanceof Error && err.name === "TimeoutError"
        ? "Garmin took too long to answer. Try again."
        : `Something went wrong talking to Garmin: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: "text", text }], isError: true };
}

const NO_KEY = `No Garmin Personal API key found. Create one at ${KEY_PAGE}, then run \`npx paceva-garmin-mcp setup\` (or set GARMIN_PERSONAL_API_KEY in this app's MCP settings).`;

/**
 * Run a section of a multi-part answer; one missing part doesn't sink the
 * rest. A rejected key does, since every part would fail the same way.
 */
async function part(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GarminError && (err.status === 401 || err.status === 403)) throw err;
    return { unavailable: err instanceof Error ? err.message : String(err) };
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerTools(server: McpServer, client: GarminClient | null): void {
  /** Every tool goes through here: no key, clear message; errors become text. */
  const tool = <S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    shape: S,
    run: (g: GarminClient, args: z.infer<z.ZodObject<S>>) => Promise<Result>,
  ) =>
    server.registerTool(
      name,
      { title, description, inputSchema: shape, annotations: { title, ...READ } },
      // The SDK has already validated args against `shape`.
      (async (args: z.infer<z.ZodObject<S>>) => {
        if (!client) return { content: [{ type: "text", text: NO_KEY }], isError: true };
        try {
          return await run(client, args);
        } catch (err) {
          return fail(err);
        }
      }) as never,
    );

  tool(
    "get_daily_overview",
    "Daily overview",
    "One day from Garmin in one call: the daily summary (steps, resting heart rate, stress, calories, intensity minutes), the night's sleep, overnight HRV and Body Battery.",
    { date: day, include_series: series },
    async (g, { date, include_series }) => {
      const d = date ?? today();
      const [summary, sleep, hrv, bodyBattery] = await Promise.all([
        part(() => g.get("/usersummary-service/v2/dailysummaries", { startDate: d, endDate: d })),
        part(() => g.get("/sleep-service/sleep/dailySleep", { date: d })),
        part(() => g.get(`/hrv-service/hrv/${d}`)),
        part(() =>
          g.get("/wellness-service/wellness/bodyBattery/reports/daily", { startDate: d, endDate: d }),
        ),
      ]);
      return ok({ date: d, summary, sleep, hrv, bodyBattery }, include_series);
    },
  );

  tool(
    "get_daily_summaries",
    "Daily summaries",
    `Daily totals for a range of days: steps, distance, calories, resting heart rate, stress, intensity minutes, floors. Up to ${MAX_RANGE_DAYS} days per call.`,
    { start_date: start, end_date: end },
    async (g, a) => {
      const [s, e] = range(a.start_date, a.end_date);
      return ok(await g.get("/usersummary-service/v2/dailysummaries", { startDate: s, endDate: e }));
    },
  );

  tool(
    "get_sleep",
    "Sleep",
    "Sleep for one night (stages, score, overnight heart rate, respiration) or, with an end_date, a nightly summary per day across a range. A night is filed under the date you woke up.",
    { start_date: day, end_date: end, include_series: series },
    async (g, a) => {
      if (!a.end_date) {
        return ok(
          await g.get("/sleep-service/sleep/dailySleep", { date: a.start_date ?? today() }),
          a.include_series,
        );
      }
      const [s, e] = range(a.start_date ?? a.end_date, a.end_date);
      return ok(
        await g.get("/sleep-service/sleep/dailySleepSummariesByDate", { startDate: s, endDate: e }),
        a.include_series,
      );
    },
  );

  tool(
    "get_hrv",
    "Heart rate variability",
    "Overnight HRV: for one night, the summary and readings; with an end_date, the nightly average, weekly average, baseline and status for each day in a range.",
    { start_date: day, end_date: end, include_series: series },
    async (g, a) => {
      if (!a.end_date) return ok(await g.get(`/hrv-service/hrv/${a.start_date ?? today()}`), a.include_series);
      const [s, e] = range(a.start_date ?? a.end_date, a.end_date);
      return ok(await g.get(`/hrv-service/hrv/daily/${s}/${e}`), a.include_series);
    },
  );

  tool(
    "get_body_battery",
    "Body Battery",
    "Garmin Body Battery per day: charged, drained, highest and lowest, for one day or a range.",
    { start_date: day, end_date: end, include_series: series },
    async (g, a) => {
      const [s, e] = range(a.start_date ?? today(), a.end_date ?? a.start_date);
      return ok(
        await g.get("/wellness-service/wellness/bodyBattery/reports/daily", { startDate: s, endDate: e }),
        a.include_series,
      );
    },
  );

  tool(
    "get_stress",
    "Stress",
    "Average and maximum all-day stress per day over a range.",
    { start_date: start, end_date: end },
    async (g, a) => {
      const [s, e] = range(a.start_date, a.end_date);
      return ok(await g.get(`/usersummary-service/stats/stress/daily/${s}/${e}`));
    },
  );

  tool(
    "get_steps",
    "Steps",
    "Steps, distance and step goal per day over a range.",
    { start_date: start, end_date: end },
    async (g, a) => {
      const [s, e] = range(a.start_date, a.end_date);
      return ok(await g.get(`/usersummary-service/stats/steps/daily/${s}/${e}`));
    },
  );

  tool(
    "get_heart_rate",
    "Heart rate (one day)",
    "One day's heart rate: resting, minimum, maximum, the 7-day resting average, and (with include_series) the readings through the day.",
    { date: day, include_series: series },
    async (g, a) =>
      ok(await g.get("/wellness-service/wellness/dailyHeartRate", { date: a.date ?? today() }), a.include_series),
  );

  tool(
    "get_spo2",
    "Pulse Ox",
    "Blood oxygen (SpO2) for one day, with altitude acclimation where the watch reports it.",
    { date: day, include_series: series },
    async (g, a) =>
      ok(await g.get(`/wellness-service/wellness/daily/spo2acclimation/${a.date ?? today()}`), a.include_series),
  );

  tool(
    "list_activities",
    "List activities",
    "Recorded activities, newest first: type, start time, duration, distance, heart rate, power, pace and training effect. Filter by date range or type (for example running, cycling, lap_swimming, strength_training). Use get_activity for one activity in full.",
    {
      start_date: isoDate.optional().describe("Earliest day, YYYY-MM-DD."),
      end_date: isoDate.optional().describe("Latest day, YYYY-MM-DD."),
      activity_type: z.string().optional().describe("Garmin activity type key, e.g. running, cycling."),
      limit: z.number().int().min(1).max(100).optional().describe("How many, 1–100. Default 20."),
      offset: z.number().int().min(0).optional().describe("Skip this many, for paging. Default 0."),
    },
    async (g, a) =>
      ok(
        await g.get("/activitylist-service/activities/search/activities", {
          start: a.offset ?? 0,
          limit: a.limit ?? 20,
          startDate: a.start_date,
          endDate: a.end_date,
          activityType: a.activity_type,
        }),
      ),
  );

  tool(
    "get_training_log",
    "Training log",
    `Every activity in a period, with the main fields from Garmin's activity list under Garmin's own names and values: distance (m), duration (s), speed (m/s), grade-adjusted speed, elevation, heart rate, cadence, power and power curve (maxAvgPower_<seconds>), TSS, intensity factor, training effect and load, fastest splits (fastestSplit_<metres>, in seconds) and seconds per heart rate and power zone. Up to ${MAX_LOG_DAYS} days per call.`,
    {
      start_date: start,
      end_date: end,
      sport: z
        .enum(["run", "bike", "swim", "other"])
        .optional()
        .describe("Only activities of this sport, by Garmin activity type. Omit for all."),
    },
    async (g, a) => {
      const [s, e] = range(a.start_date, a.end_date, MAX_LOG_DAYS);
      const rows: Record<string, unknown>[] = [];
      for (let offset = 0; offset < MAX_LOG_ROWS; offset += 100) {
        const page = (await g.get("/activitylist-service/activities/search/activities", {
          start: offset,
          limit: 100,
          startDate: s,
          endDate: e,
        })) as Record<string, unknown>[] | null;
        if (!Array.isArray(page) || page.length === 0) break;
        for (const act of page) {
          if (!a.sport || sportOf(typeKeyOf(act)) === a.sport) rows.push(logRow(act));
        }
        if (page.length < 100) break;
      }
      // Rows are already cut down; a year of them must not be summarized away.
      return text({ from: s, to: e, activities: rows.length, rows });
    },
  );

  tool(
    "get_activity",
    "Activity details",
    "One activity in full: summary, laps or splits where available, and with include_workouts the structured workout it followed.",
    {
      activity_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).describe(
        "The activityId from list_activities.",
      ),
      include_workouts: z.boolean().optional().describe("Also fetch the structured workout, if any."),
    },
    async (g, a) => {
      const id = String(a.activity_id);
      const activity = await g.get(`/activity-service/activity/${id}`);
      if (!a.include_workouts) return ok(activity);
      const workouts = await part(() => g.get(`/activity-service/activity/${id}/workouts`));
      return ok({ activity, workouts });
    },
  );

  tool(
    "get_profile",
    "Profile and zones",
    "Profile settings from Garmin Connect (units, age, sex, height, weight and others) and heart rate zones.",
    {},
    async (g) => {
      const [settings, heartRateZones] = await Promise.all([
        part(() => g.get("/userprofile-service/userprofile/settings")),
        part(() => g.get("/biometric-service/heartRateZones/v2")),
      ]);
      return ok({ settings, heartRateZones });
    },
  );

  tool(
    "get_weight",
    "Weight and body composition",
    "Weigh-ins over a range, with body fat, muscle mass and BMI where a scale records them.",
    { start_date: start, end_date: end },
    async (g, a) => {
      const [s, e] = range(a.start_date, a.end_date);
      return ok(await g.get(`/weight-service/weight/range/${s}/${e}`, { includeAll: "true" }));
    },
  );

  tool(
    "get_fitness_age",
    "Fitness age",
    "Garmin's fitness age for a date.",
    { date: day },
    async (g, a) => ok(await g.get(`/fitnessage-service/fitnessage/v2/${a.date ?? today()}`)),
  );

  tool(
    "get_hydration",
    "Hydration",
    "Logged water intake against goal per day over a range.",
    { start_date: start, end_date: end },
    async (g, a) => {
      const [s, e] = range(a.start_date, a.end_date);
      return ok(await g.get(`/usersummary-service/stats/hydration/daily/${s}/${e}`));
    },
  );

  tool(
    "get_food_log",
    "Food log",
    "Foods logged in Garmin Connect for one day, with calories and macros.",
    { date: day },
    async (g, a) => ok(await g.get(`/nutrition-service/food/logs/${a.date ?? today()}`)),
  );

  tool(
    "get_menstrual_cycle",
    "Menstrual cycle",
    "Cycle tracking for a date, if it's tracked in Garmin Connect.",
    { date: day },
    async (g, a) => {
      const d = a.date ?? today();
      const [summary, dayView] = await Promise.all([
        part(() => g.get(`/periodichealth-service/menstrualcycle/summary/${d}`)),
        part(() => g.get(`/periodichealth-service/menstrualcycle/dayview/${d}`, { todayDate: today() })),
      ]);
      return ok({ summary, dayView });
    },
  );
}

export const INSTRUCTIONS = `Read-only access to the user's own Garmin Connect data through Garmin's Personal API. Responses are Garmin's data as Garmin returns it, in Garmin's field names and units (metres, seconds, metres per second), with empty fields and account IDs left out. Long minute-by-minute series are summarized as count, min, max and average unless include_series is set. Dates are YYYY-MM-DD in the user's time zone.`;
