import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { compact } from "../src/compact.js";
import { GarminClient } from "../src/garmin.js";
import { addDays, INSTRUCTIONS, MAX_RANGE_DAYS, range, registerTools, today } from "../src/tools.js";
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
