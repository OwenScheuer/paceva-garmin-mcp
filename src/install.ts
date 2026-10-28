import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { findApiKey, GarminClient, KEY_PAGE, saveApiKey } from "./garmin.js";

/**
 * `npx github:OwenScheuer/paceva-garmin-mcp`, run in a terminal: the whole
 * setup in one go. Opens Garmin's key page, takes the key from the clipboard
 * once it's copied, checks it with Garmin, saves it, and adds the server to
 * every AI app it finds on this computer.
 */

const run = promisify(execFile);

export const PACKAGE = "github:OwenScheuer/paceva-garmin-mcp";
export const SERVER = { command: "npx", args: ["-y", PACKAGE] };
export const SERVER_NAME = "garmin";

type ServerEntry = { command: string; args: string[]; env?: Record<string, string> };

/**
 * The entry written into an app's JSON config. Apps opened from the Dock or
 * Start menu don't get the terminal's PATH, so a bare "npx" often can't be
 * found there; point at the npx beside the Node running this, and give it a
 * PATH that includes Node.
 */
export function appServer(execPath = process.execPath, platform = process.platform): ServerEntry {
  const nodeDir = dirname(execPath);
  const npx = join(nodeDir, platform === "win32" ? "npx.cmd" : "npx");
  if (!existsSync(npx)) return SERVER;
  const base = platform === "win32" ? [] : ["/usr/local/bin", "/usr/bin", "/bin"];
  return { command: npx, args: SERVER.args, env: { PATH: [...new Set([nodeDir, ...base])].join(delimiter) } };
}

/** Garmin's personal keys are long URL-safe tokens; anything else on the clipboard isn't one. */
export function looksLikeKey(text: string): boolean {
  return /^[A-Za-z0-9._\-+/=]{40,}$/.test(text.trim());
}

type App = { name: string; file: string; key: "mcpServers" };

/** AI apps that keep MCP servers in a JSON file, where that file lives on this platform. */
export function jsonApps(home = homedir(), platform = process.platform, env = process.env): App[] {
  const claudeDir =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude")
      : platform === "win32"
        ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude")
        : join(home, ".config", "Claude");
  return [
    { name: "Claude Desktop", file: join(claudeDir, "claude_desktop_config.json"), key: "mcpServers" },
    { name: "Cursor", file: join(home, ".cursor", "mcp.json"), key: "mcpServers" },
    { name: "Windsurf", file: join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
  ];
}

/**
 * Add the server to one app's config, keeping everything else in it.
 * Returns what happened; never overwrites a file it can't parse.
 */
export async function addToConfig(
  file: string,
  server: ServerEntry = SERVER,
): Promise<"added" | "already" | "unreadable"> {
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    const raw = (await readFile(file, "utf8")).trim();
    if (raw) {
      try {
        config = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return "unreadable";
      }
      if (typeof config !== "object" || config === null || Array.isArray(config)) return "unreadable";
    }
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || Array.isArray(servers)) return "unreadable";
  if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(server)) return "already";
  if (existsSync(file)) await copyFile(file, `${file}.bak`);
  config.mcpServers = { ...servers, [SERVER_NAME]: server };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return "added";
}

async function readClipboard(): Promise<string> {
  const tries: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbpaste", []]]
      : process.platform === "win32"
        ? [["powershell", ["-NoProfile", "-Command", "Get-Clipboard"]]]
        : [
            ["wl-paste", ["--no-newline"]],
            ["xclip", ["-selection", "clipboard", "-o"]],
            ["xsel", ["--clipboard", "--output"]],
          ];
  for (const [cmd, args] of tries) {
    try {
      return (await run(cmd, args, { timeout: 3000 })).stdout.trim();
    } catch {
      // try the next one
    }
  }
  return "";
}

function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(cmd, args, () => {});
}

async function hasClaudeCode(): Promise<boolean> {
  try {
    await run("claude", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function addToClaudeCode(): Promise<"added" | "already" | "failed"> {
  try {
    await run("claude", ["mcp", "get", SERVER_NAME], { timeout: 15_000 });
    return "already";
  } catch {
    // not there yet
  }
  try {
    await run("claude", ["mcp", "add", "--scope", "user", SERVER_NAME, "--", SERVER.command, ...SERVER.args], {
      timeout: 30_000,
    });
    return "added";
  } catch {
    return "failed";
  }
}

const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

export async function install({ newKey = false } = {}): Promise<void> {
  const say = (s = "") => process.stdout.write(`${s}\n`);
  const ask = async (q: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  };
  {
    say(bold("\nPaceva for Garmin\n"));

    // 1. The key: reuse a saved one that still works, else fetch a new one.
    let key = newKey ? null : await findApiKey();
    if (key) {
      try {
        await new GarminClient({ apiKey: key }).verify();
        say(`${green("✓")} Your Garmin key is already set up.`);
      } catch {
        say("Your saved Garmin key no longer works, so let's get a new one.");
        key = null;
      }
    }
    while (!key) {
      say(`${bold("1.")} Opening Garmin Connect in your browser…`);
      openUrl(KEY_PAGE);
      say(`   Select ${bold("Create Key")}, accept, choose how long it lasts, then ${bold("Copy")} the key.`);
      say(dim(`   (If the page didn't open: ${KEY_PAGE})`));
      await ask(`\n   Copied it? Press ${bold("Enter")}. `);
      let candidate = await readClipboard();
      if (!looksLikeKey(candidate)) {
        candidate = await askHidden("   Couldn't read it from the clipboard. Paste the key here: ");
      }
      if (!candidate) continue;
      process.stdout.write("   Checking it with Garmin… ");
      try {
        await new GarminClient({ apiKey: candidate }).verify();
        await saveApiKey(candidate);
        say(green("✓ works"));
        key = candidate;
      } catch (err) {
        say(`\n   ${err instanceof Error ? err.message : String(err)}`);
        const again = await ask("   Try again? [Y/n] ");
        if (/^n/i.test(again.trim())) return;
      }
    }

    // 2. Add it to every AI app on this computer.
    say(`\n${bold("2.")} Adding Paceva to your AI apps…`);
    const found = jsonApps().filter((a) => existsSync(dirname(a.file)));
    const claudeCode = await hasClaudeCode();
    if (!found.length && !claudeCode) {
      say("   No Claude Desktop, Claude Code, Cursor or Windsurf found. Add this to your app's MCP servers:");
      say(`   "${SERVER_NAME}": ${JSON.stringify(SERVER)}`);
    }
    for (const app of found) {
      const result = await addToConfig(app.file, appServer());
      say(
        result === "unreadable"
          ? `   – ${app.name}: couldn't read its settings file, so left it alone (${app.file})`
          : `   ${green("✓")} ${app.name}${result === "already" ? dim(" (already added)") : ""}`,
      );
    }
    if (claudeCode) {
      const result = await addToClaudeCode();
      say(
        result === "failed"
          ? `   – Claude Code: run  claude mcp add ${SERVER_NAME} -- npx -y ${PACKAGE}`
          : `   ${green("✓")} Claude Code${result === "already" ? dim(" (already added)") : ""}`,
      );
    }

    say(`\n${green("Done.")} Restart your AI app, then ask: ${bold("\"How did I sleep last night?\"")}\n`);
  }
}

/** Ask for a line without echoing it, so a pasted key never shows on screen. */
export function askHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    // Piped in: read it all.
    return new Promise((resolve) => {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => (data += c));
      stdin.on("end", () => resolve(data.trim()));
    });
  }
  stdout.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          return resolve(value.trim());
        }
        if (ch === "\u0003") {
          done();
          return reject(new Error("cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
        } else if (ch >= " ") {
          value += ch;
          stdout.write("•");
        }
      }
    };
    stdin.on("data", onData);
  });
}
