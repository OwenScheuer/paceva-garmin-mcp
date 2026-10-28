import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { compact } from "../src/compact.js";
import { GarminClient } from "../src/garmin.js";
import {
  addDays,
  INSTRUCTIONS,
  logRow,
  MAX_LOG_DAYS,
  MAX_RANGE_DAYS,
  range,
  registerTools,
  sportOf,
  today,
} from "../src/tools.js";
import { VERSION } from "../src/version.js";
import { fakeGarmin } from "./fake-garmin.js";

async function connect(client: GarminClient | null) {
  const server = new McpServer({ name: "t", version: "0" }, { instructions: INSTRUCTIONS });
  registerTools(server, client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return mcp;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

describe("tools", () => {
  it("lists read-only tools with descriptions", async () => {
    const mcp = await connect(null);
    const { tools } = await mcp.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(15);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.description!.length).toBeGreaterThan(20);
    }
  });

  it("tells the person how to add a key when there isn't one", async () => {
    const mcp = await connect(null);
    const r = await mcp.callTool({ name: "get_daily_overview", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/npx paceva-garmin-mcp setup/);
  });

  it("builds the overview from four calls and keeps going when one fails", async () => {
    const d = "2026-10-20";
    const g = fakeGarmin({
      routes: {
        "/usersummary-service/v2/dailysummaries": { data: [{ restingHeartRate: 53 }] },
        "/sleep-service/sleep/dailySleep": {
          dailySleepDTO: { sleepTimeSeconds: 25000 },
          sleepLevels: Array.from({ length: 300 }, (_, i) => ({ start: i, level: 1 })),
        },
        [`/hrv-service/hrv/${d}`]: { hrvSummary: { lastNightAvg: 61, status: "BALANCED" } },
      },
    });
    const mcp = await connect(new GarminClient({ apiKey: "good-key", fetch: g.fetch, cacheFile: null }));
    const r = await mcp.callTool({ name: "get_daily_overview", arguments: { date: d } });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(text(r));
    expect(body.summary.data[0].restingHeartRate).toBe(53);
    expect(body.hrv.hrvSummary.lastNightAvg).toBe(61);
    expect(body.sleep.sleepLevels.omitted).toMatch(/300 readings/);
    expect(body.bodyBattery).toBeUndefined(); // Garmin sent nothing; dropped, not an error
  });

  it("fails the whole overview, once, when the key is rejected", async () => {
    const g = fakeGarmin();
    const mcp = await connect(new GarminClient({ apiKey: "expired", fetch: g.fetch, cacheFile: null }));
    const r = await mcp.callTool({ name: "get_daily_overview", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Garmin didn't accept your Personal API key/);
    expect(g.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("uses the single-night endpoint without end_date and the range one with it", async () => {
    const g = fakeGarmin();
    const mcp = await connect(new GarminClient({ apiKey: "good-key", fetch: g.fetch, cacheFile: null }));
    await mcp.callTool({ name: "get_hrv", arguments: { start_date: "2026-10-01" } });
    await mcp.callTool({
      name: "get_hrv",
      arguments: { start_date: "2026-10-01", end_date: "2026-10-07" },
    });
    const paths = g.calls.filter((c) => c.method === "GET").map((c) => c.path);
    expect(paths).toEqual(["/hrv-service/hrv/2026-10-01", "/hrv-service/hrv/daily/2026-10-01/2026-10-07"]);
  });

  it("refuses a range that's too long, with a way forward", async () => {
    const g = fakeGarmin();
    const mcp = await connect(new GarminClient({ apiKey: "good-key", fetch: g.fetch, cacheFile: null }));
    const r = await mcp.callTool({
      name: "get_daily_summaries",
      arguments: { start_date: "2025-01-01", end_date: "2026-01-01" },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/split longer periods/);
    expect(g.calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  it("pages activities and filters by type", async () => {
    const g = fakeGarmin({
      routes: { "/activitylist-service/activities/search/activities": [{ activityId: 1 }] },
    });
    const mcp = await connect(new GarminClient({ apiKey: "good-key", fetch: g.fetch, cacheFile: null }));
    const r = await mcp.callTool({
      name: "list_activities",
      arguments: { activity_type: "running", limit: 5, offset: 10 },
    });
    expect(JSON.parse(text(r))).toEqual([{ activityId: 1 }]);
    expect(g.calls.at(-1)!.search).toBe("?start=10&limit=5&activityType=running");
  });

  it("rejects malformed dates before calling Garmin", async () => {
    const g = fakeGarmin();
    const mcp = await connect(new GarminClient({ apiKey: "good-key", fetch: g.fetch, cacheFile: null }));
    const r = await mcp.callTool({ name: "get_sleep", arguments: { start_date: "yesterday" } });
    expect(r.isError).toBe(true);
    expect(g.calls).toHaveLength(0);
  });
});

describe("training log", () => {
  it("keeps Garmin's own fields and values, and drops the rest", () => {
    const garmin = {
      activityId: 7,
      activityName: "Tempo",
      startTimeLocal: "2026-10-20 07:05:11",
      activityType: { typeId: 1, typeKey: "running", parentTypeId: 17 },
      distance: 10000.37,
      duration: 2700.5,
      averageSpeed: 3.7036999464035034,
      avgGradeAdjustedSpeed: 3.77,
      averageHR: 162,
      aerobicTrainingEffect: 2.799999952316284,
      fastestSplit_5000: 1320.2,
      hrTimeInZone_4: 1500.1,
      maxAvgPower_1200: 281,
      ownerFullName: "A Person",
      startLatitude: 42.1,
      privacy: { typeKey: "private" },
      pr: false,
      hasImages: false,
      minTemperature: 12,
    };
    expect(logRow(garmin)).toEqual({
      activityId: 7,
      activityName: "Tempo",
      startTimeLocal: "2026-10-20 07:05:11",
      activityType: { typeKey: "running" },
      distance: 10000.37,
      duration: 2700.5,
      averageSpeed: 3.7036999464035034,
      avgGradeAdjustedSpeed: 3.77,
      averageHR: 162,
      aerobicTrainingEffect: 2.799999952316284,
      fastestSplit_5000: 1320.2,
      hrTimeInZone_4: 1500.1,
      maxAvgPower_1200: 281,
    });
  });

  it("buckets Garmin's activity types", () => {
    expect(["running", "trail_running", "track_running", "treadmill_running"].map(sportOf)).toEqual(
      Array(4).fill("run"),
    );
    expect(["road_biking", "virtual_ride", "cycling", "indoor_cycling", "mountain_biking"].map(sportOf)).toEqual(
      Array(5).fill("bike"),
    );
    expect(["lap_swimming", "open_water_swimming"].map(sportOf)).toEqual(["swim", "swim"]);
    expect(["strength_training", "walking", "yoga"].map(sportOf)).toEqual(Array(3).fill("other"));
  });

  it("pages through Garmin 100 at a time and filters by sport", async () => {
    const page = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({
        activityId: offset + i,
        activityType: { typeKey: i % 2 ? "running" : "road_biking" },
      }));
    let served = 0;
    const g = fakeGarmin();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/activities/search/activities")) {
        served += 1;
        const offset = Number(url.searchParams.get("start"));
        const n = offset < 200 ? 100 : 30;
        return new Response(JSON.stringify(page(n, offset)), { status: 200 });
      }
      return g.fetch(input, init);
    }) as typeof fetch;
    const mcp = await connect(new GarminClient({ apiKey: "good-key", fetch: fetchImpl, cacheFile: null }));
    const r = await mcp.callTool({
      name: "get_training_log",
      arguments: { start_date: addDays(today(), -300), sport: "run" },
    });
    const body = JSON.parse(text(r));
    expect(served).toBe(3);
    expect(body.activities).toBe(115); // 230 activities, half of them runs
    const all = JSON.parse(
      text(await mcp.callTool({ name: "get_training_log", arguments: { start_date: addDays(today(), -300) } })),
    );
    expect(all.rows).toHaveLength(230); // a long log is never summarized away
    expect(body.rows.every((row: { activityType: { typeKey: string } }) => row.activityType.typeKey === "running")).toBe(true);
  });

  it("allows a year but not more", () => {
    const t = today();
    expect(() => range(addDays(t, -(MAX_LOG_DAYS - 1)), t, MAX_LOG_DAYS)).not.toThrow();
    expect(() => range(addDays(t, -MAX_LOG_DAYS), t, MAX_LOG_DAYS)).toThrow();
  });
});

describe("range", () => {
  it("defaults the end to today and allows exactly the maximum", () => {
    const t = today();
    expect(range(addDays(t, -6))).toEqual([addDays(t, -6), t]);
    expect(() => range(addDays(t, -(MAX_RANGE_DAYS - 1)), t)).not.toThrow();
    expect(() => range(addDays(t, -MAX_RANGE_DAYS), t)).toThrow();
  });
  it("rejects a start after the end", () => {
    expect(() => range("2026-10-10", "2026-10-01")).toThrow(/after/);
  });
});

describe("compact", () => {
  it("drops empty values and summarizes [time, value] series, ignoring Garmin's negative gaps", () => {
    const series = Array.from({ length: 50 }, (_, i) => [i, i % 10 === 0 ? -1 : 40 + (i % 5)]);
    expect(compact({ a: null, b: [], c: {}, d: 0, heartRateValues: series })).toEqual({
      d: 0,
      heartRateValues: {
        omitted: "50 readings; ask again with include_series to see them",
        min: 40,
        max: 44,
        avg: expect.any(Number),
      },
    });
  });
  it("drops IDs, the owner's name and profile photos, keeping the activity's own ID", () => {
    expect(
      compact({
        activityId: 9,
        ownerId: 1,
        ownerFullName: "A Person",
        ownerProfileImageUrlSmall: "https://x",
        sleepNeed: { userProfilePk: 1, deviceId: 2, actual: 560 },
      }),
    ).toEqual({ activityId: 9, sleepNeed: { actual: 560 } });
  });
  it("keeps series when asked", () => {
    const series = Array.from({ length: 50 }, (_, i) => [i, 1]);
    expect((compact({ heartRateValues: series }, { includeSeries: true }) as any).heartRateValues).toHaveLength(50);
  });
  it("leaves short lists alone", () => {
    expect(compact({ data: [{ x: 1 }, { x: 2 }] })).toEqual({ data: [{ x: 1 }, { x: 2 }] });
  });
});

describe("version", () => {
  it("matches package.json", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});
