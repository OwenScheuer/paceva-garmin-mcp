import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact } from "./compact.js";
import { GarminError, type GarminClient, KEY_PAGE } from "./garmin.js";

/** Longest range one call may ask for, so a question can't pull years at once. */
export const MAX_RANGE_DAYS = 92;

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
export function range(startDate: string, endDate?: string): [string, string] {
  const last = endDate ?? today();
  if (startDate > last) throw new GarminError(`start_date ${startDate} is after end_date ${last}.`);
  const days = (Date.parse(last) - Date.parse(startDate)) / 86_400_000 + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new GarminError(
      `That's ${days} days; ask for ${MAX_RANGE_DAYS} or fewer at a time and split longer periods.`,
    );
  }
  return [startDate, last];
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown, includeSeries = false): Result {
  const body = compact(data, { includeSeries });
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

export const INSTRUCTIONS = `Read-only access to one person's own Garmin Connect data through Garmin's Personal API. All numbers are Garmin's: say so, and don't present your own estimates as Garmin's. Dates are calendar dates in the person's time zone; a night's sleep is filed under the morning it ended. For "how am I today" questions start with get_daily_overview; for trends use the range tools (up to ${MAX_RANGE_DAYS} days per call). Long minute-by-minute series are summarized unless include_series is set. Training readiness, training status and recovery time have no Personal API endpoint. If a number isn't in a response, say it isn't available rather than guessing.`;
