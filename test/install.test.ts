import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addToConfig, appServer, jsonApps, looksLikeKey, SERVER } from "../src/install.js";

const tmp = () => mkdtemp(join(tmpdir(), "pgi-"));

describe("looksLikeKey", () => {
  it("accepts a long URL-safe token and rejects other clipboard contents", () => {
    expect(looksLikeKey(`${"aB3-_.+/".repeat(16)}x`)).toBe(true);
    expect(looksLikeKey("https://connect.garmin.com/app/settings")).toBe(false);
    expect(looksLikeKey("hello world")).toBe(false);
    expect(looksLikeKey("")).toBe(false);
  });
});

describe("jsonApps", () => {
  it("knows where Claude Desktop keeps its config on each platform", () => {
    const at = (p: NodeJS.Platform) => jsonApps("/h", p, { APPDATA: "C:\\A" })[0]!.file;
    expect(at("darwin")).toBe("/h/Library/Application Support/Claude/claude_desktop_config.json");
    expect(at("linux")).toBe("/h/.config/Claude/claude_desktop_config.json");
    expect(at("win32")).toContain("Claude");
  });
});

describe("appServer", () => {
  it("points at the npx beside this Node, with Node on the PATH", () => {
    const entry = appServer(process.execPath, process.platform);
    expect(entry.args).toEqual(SERVER.args);
    if (entry.env) {
      expect(entry.command).toMatch(/npx(\.cmd)?$/);
      expect(entry.env.PATH!.split(/[:;]/)[0]).toBe(join(process.execPath, ".."));
    }
  });
  it("falls back to plain npx when there's none beside Node", () => {
    expect(appServer("/nowhere/node", "linux")).toEqual(SERVER);
  });
});

describe("addToConfig", () => {
  it("creates a config with just the server", async () => {
    const file = join(await tmp(), "sub", "mcp.json");
    expect(await addToConfig(file)).toBe("added");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ mcpServers: { garmin: SERVER } });
  });

  it("keeps the app's other settings and servers, and backs the file up first", async () => {
    const file = join(await tmp(), "claude_desktop_config.json");
    const before = { preferences: { x: 1 }, mcpServers: { other: { command: "o" } } };
    await writeFile(file, JSON.stringify(before));
    expect(await addToConfig(file)).toBe("added");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      preferences: { x: 1 },
      mcpServers: { other: { command: "o" }, garmin: SERVER },
    });
    expect(JSON.parse(await readFile(`${file}.bak`, "utf8"))).toEqual(before);
  });

  it("does nothing the second time", async () => {
    const file = join(await tmp(), "mcp.json");
    await addToConfig(file);
    expect(await addToConfig(file)).toBe("already");
  });

  it("never touches a file it can't parse", async () => {
    const file = join(await tmp(), "mcp.json");
    await writeFile(file, "{ not json");
    expect(await addToConfig(file)).toBe("unreadable");
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });
});
