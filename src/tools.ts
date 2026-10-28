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

const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
/** A positive number rounded, else undefined. */
const n = (v: unknown, dp = 0) => (num(v) ? round(v as number, dp) : undefined);

/** Seconds as m:ss (or h:mm:ss). */
export function clock(sec: number): string {
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Pace for `per` metres at `speed` m/s. */
const pace = (speed: number | undefined, per: number) => (speed ? clock(per / speed) : undefined);

/** One activity from Garmin's list as a compact training-log row. */
export function logRow(a: Record<string, unknown>): Record<string, unknown> {
  const typeKey = String((a.activityType as { typeKey?: string } | undefined)?.typeKey ?? "other");
  const sport = sportOf(typeKey);
  const distance = num(a.distance);
  const speed = num(a.averageSpeed);
  const gap = num(a.avgGradeAdjustedSpeed);
  const zones = [1, 2, 3, 4, 5].map((z) => num(a[`hrTimeInZone_${z}`]));
  const split = (k: string) => (num(a[k]) ? clock(a[k] as number) : undefined);
  const row: Record<string, unknown> = {
    id: a.activityId,
    date: typeof a.startTimeLocal === "string" ? a.startTimeLocal.slice(0, 16) : undefined,
    sport,
    type: typeKey,
    name: a.activityName,
    km: distance ? round(distance / 1000, 2) : undefined,
    min: num(a.duration) ? round((a.duration as number) / 60) : undefined,
    moving_min: num(a.movingDuration) ? round((a.movingDuration as number) / 60) : undefined,
    pace_km: sport === "run" || typeKey === "walking" || typeKey === "hiking" ? pace(speed, 1000) : undefined,
    gap_pace_km: sport === "run" ? pace(gap, 1000) : undefined,
    kmh: sport === "bike" && speed ? round(speed * 3.6) : undefined,
    pace_100m: sport === "swim" ? pace(speed, 100) : undefined,
    elev_gain_m: num(a.elevationGain) ? Math.round(a.elevationGain as number) : undefined,
    avg_hr: n(a.averageHR),
    max_hr: n(a.maxHR),
    avg_power: n(a.avgPower),
    norm_power: n(a.normPower),
    best_20min_power: n(a.max20MinPower),
    ftp: n(a.maxFtp),
    tss: n(a.trainingStressScore, 1),
    intensity_factor: n(a.intensityFactor, 2),
    cadence:
      n(a.averageRunningCadenceInStepsPerMinute) ??
      n(a.averageBikingCadenceInRevPerMinute) ??
      n(a.averageSwimCadenceInStrokesPerMinute),
    aerobic_te: n(a.aerobicTrainingEffect, 1),
    anaerobic_te: n(a.anaerobicTrainingEffect, 1),
    te_label: a.trainingEffectLabel,
    load: n(a.activityTrainingLoad),
    fastest_1k: split("fastestSplit_1000"),
    fastest_mile: split("fastestSplit_1609"),
    fastest_5k: split("fastestSplit_5000"),
    fastest_10k: split("fastestSplit_10000"),
    fastest_100m: split("fastestSplit_100"),
    fastest_400m: split("fastestSplit_400"),
    fastest_40k: split("fastestSplit_40000"),
    hr_zone_min: zones.some(Boolean) ? zones.map((z) => (z ? round(z / 60) : 0)) : undefined,
    pr: a.pr === true || undefined,
  };
  for (const k of Object.keys(row)) if (row[k] === undefined || row[k] === null) delete row[k];
  return row;
}

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
    "One day at a glance: the daily summary (steps, resting heart rate, stress, calories, intensity minutes), last night's sleep, overnight HRV and Body Battery. Start here for questions like 'how recovered am I?' or 'how did I sleep?'.",
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
    `Daily totals for a range of days: steps, distance, calories, resting heart rate, stress, intensity minutes, floors. Up to ${MAX_RANGE_DAYS} days per call. Good for trends.`,
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
    `Every workout in a period as one compact row: date, sport, distance, time, pace or speed, grade-adjusted pace, elevation, heart rate, power (average, normalized, best 20 min, FTP), TSS, training effect and load, fastest splits (1 km, mile, 5K, 10K; 100 m and 400 m swims; 40 km rides) and minutes per heart rate zone. This is the raw material for race predictions, fitness trends and training-load questions: work those out from these rows yourself. Up to ${MAX_LOG_DAYS} days per call; 8–16 weeks is usually enough for a prediction.`,
    {
      start_date: start,
      end_date: end,
      sport: z
        .enum(["run", "bike", "swim", "other"])
        .optional()
        .describe("Only this sport. Omit for everything."),
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
          const row = logRow(act);
          if (!a.sport || row.sport === a.sport) rows.push(row);
        }
        if (page.length < 100) break;
      }
      // Rows are already compact; a year of them must not be summarized away.
      return text({
        from: s,
        to: e,
        workouts: rows.length,
        units: "km, minutes, m, bpm, W; paces as m:ss",
        rows,
      });
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
    "The athlete's profile settings (units, age, sex, height, weight and other values set in Garmin Connect) and heart rate zones. Use it to interpret other numbers.",
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
    "Garmin's fitness age for a date, and what moves it.",
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
    "Cycle tracking for a date: cycle day, phase and predictions, if the athlete tracks their cycle in Garmin Connect.",
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

export const INSTRUCTIONS = `Read-only access to one person's own Garmin Connect data through Garmin's Personal API. Every number these tools return is Garmin's; anything you calculate from them is yours, so keep the two apart. Dates are calendar dates in the person's time zone; a night's sleep is filed under the morning it ended. For "how am I today" questions start with get_daily_overview; for trends use the range tools (up to ${MAX_RANGE_DAYS} days per call). For race predictions, fitness and training-load questions, pull get_training_log and work it out yourself from the raw rows; say that the prediction is your estimate from their Garmin data, give a range rather than one time, and show what it's based on. Long minute-by-minute series are summarized unless include_series is set. Training readiness, training status and recovery time have no Personal API endpoint. If a number isn't in a response, say it isn't available rather than guessing.`;
