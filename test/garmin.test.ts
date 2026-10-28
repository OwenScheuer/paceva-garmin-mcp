import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findApiKey, GarminClient, jwtExpiry } from "../src/garmin.js";
import { fakeGarmin, jwt } from "./fake-garmin.js";

describe("GarminClient", () => {
  it("exchanges the key once and reuses the token", async () => {
    const g = fakeGarmin({ routes: { "/x": { a: 1 } } });
    const c = new GarminClient({ apiKey: "good-key", fetch: g.fetch, cacheFile: null });
    expect(await c.get("/x")).toEqual({ a: 1 });
    await c.get("/x");
    expect(g.issued()).toBe(1);
    expect(g.calls[0]).toMatchObject({ method: "POST", auth: "ApiKey good-key" });
    expect(g.calls[1]!.auth).toMatch(/^Bearer /);
  });

  it("shares one exchange between calls made at the same time", async () => {
    const g = fakeGarmin();
    const c = new GarminClient({ apiKey: "good-key", fetch: g.fetch, cacheFile: null });
    await Promise.all([c.get("/a"), c.get("/b"), c.get("/c")]);
    expect(g.issued()).toBe(1);
  });

  it("caches the token on disk, readable only by the owner, for the same key only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pg-"));
    const cacheFile = join(dir, "token.json");
    const g = fakeGarmin();
    await new GarminClient({ apiKey: "good-key", fetch: g.fetch, cacheFile }).get("/a");
    expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(cacheFile, "utf8")).not.toContain("good-key");

    await new GarminClient({ apiKey: "good-key", fetch: g.fetch, cacheFile }).get("/a");
    expect(g.issued()).toBe(1);

    const other = fakeGarmin({ validKey: "other-key" });
    await new GarminClient({ apiKey: "other-key", fetch: other.fetch, cacheFile }).get("/a");
    expect(other.issued()).toBe(1);
  });

  it("renews a token with under an hour left", async () => {
    const g = fakeGarmin();
    let now = Date.now();
    const c = new GarminClient({ apiKey: "good-key", fetch: g.fetch, cacheFile: null, now: () => now });
    await c.get("/a");
    now += 23.5 * 3600 * 1000;
    await c.get("/a");
    expect(g.issued()).toBe(2);
  });

  it("re-exchanges once when Garmin rejects a token early", async () => {
    const g = fakeGarmin({ revokeFirst: 1, routes: { "/a": { ok: true } } });
    const c = new GarminClient({ apiKey: "good-key", fetch: g.fetch, cacheFile: null });
    expect(await c.get("/a")).toEqual({ ok: true });
    expect(g.issued()).toBe(2);
  });

  it("explains a rejected key and where to get a new one", async () => {
    const g = fakeGarmin();
    const c = new GarminClient({ apiKey: "expired", fetch: g.fetch, cacheFile: null });
    await expect(c.get("/a")).rejects.toThrow(/expired or been deleted.*personalApiToken/);
  });

  it("turns rate limits and server errors into plain messages", async () => {
    const limited = new GarminClient({
      apiKey: "good-key",
      fetch: fakeGarmin({ dataStatus: 429 }).fetch,
      cacheFile: null,
    });
    await expect(limited.get("/a")).rejects.toThrow(/rate-limiting/);
    const down = new GarminClient({
      apiKey: "good-key",
      fetch: fakeGarmin({ dataStatus: 503 }).fetch,
      cacheFile: null,
    });
    await expect(down.get("/a")).rejects.toThrow(/servers returned an error \(503\)/);
  });

  it("passes query parameters and drops undefined ones", async () => {
    const g = fakeGarmin();
    const c = new GarminClient({ apiKey: "good-key", fetch: g.fetch, cacheFile: null });
    await c.get("/q", { startDate: "2026-10-01", activityType: undefined, limit: 5 });
    expect(g.calls.at(-1)!.search).toBe("?startDate=2026-10-01&limit=5");
  });

  it("returns null for an empty body", async () => {
    const c = new GarminClient({ apiKey: "good-key", fetch: fakeGarmin().fetch, cacheFile: null });
    expect(await c.get("/empty")).toBeNull();
  });
});

describe("findApiKey", () => {
  it("prefers the environment variable, trimmed", async () => {
    expect(await findApiKey({ GARMIN_PERSONAL_API_KEY: "  abc \n" })).toBe("abc");
  });
});

describe("jwtExpiry", () => {
  it("reads exp in milliseconds", () => {
    const now = 1_800_000_000_000;
    expect(jwtExpiry(jwt(60, now))).toBe(now + 60_000);
  });
  it("rejects something that isn't a JWT", () => {
    expect(() => jwtExpiry("not-a-token")).toThrow(/can't read/);
  });
});
