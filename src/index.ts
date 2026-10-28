#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findApiKey, GarminClient, GarminError, KEY_PAGE, saveApiKey } from "./garmin.js";
import { INSTRUCTIONS, registerTools, today } from "./tools.js";
import { VERSION } from "./version.js";

const HELP = `paceva-garmin-mcp ${VERSION}
Your own Garmin Connect data in Claude, ChatGPT or any MCP app. Free, local, read-only.

  npx github:OwenScheuer/paceva-garmin-mcp setup   Save your Garmin Personal API key and check it works
  npx github:OwenScheuer/paceva-garmin-mcp check   Check the saved key and show today's numbers
  npx github:OwenScheuer/paceva-garmin-mcp         Run the MCP server (your AI app does this for you)

Get a key: ${KEY_PAGE}
`;

async function serve(): Promise<void> {
  const key = await findApiKey();
  // Start even without a key, so the AI app can tell the person how to add one.
  const client = key ? new GarminClient({ apiKey: key }) : null;
  const server = new McpServer(
    { name: "paceva-garmin", title: "Paceva for Garmin", version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, client);
  await server.connect(new StdioServerTransport());
  if (!key) console.error(`paceva-garmin-mcp: no API key yet. Run: npx github:OwenScheuer/paceva-garmin-mcp setup`);
}

/** Ask for a line without echoing it, so the key never shows on screen. */
function askHidden(question: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    // Piped in: read it all.
    return new Promise((resolve) => {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => (data += c));
      stdin.on("end", () => resolve(data.trim()));
    });
  }
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stderr.write("\n");
          return resolve(value.trim());
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          stderr.write("\n");
          return reject(new Error("cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            stderr.write("\b \b");
          }
        } else if (ch >= " ") {
          value += ch;
          stderr.write("•");
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function setup(): Promise<void> {
  const out = (s = "") => process.stderr.write(`${s}\n`);
  out("Paceva for Garmin: setup\n");
  out(`1. Open ${KEY_PAGE}`);
  out("2. Select Create Key, accept the terms, choose how long it lasts, then Create.");
  out("3. Copy the key (Garmin shows it only once) and paste it here.\n");
  const key = await askHidden("Garmin Personal API key: ");
  if (!key) {
    out("No key entered; nothing saved.");
    process.exitCode = 1;
    return;
  }
  out("Checking it with Garmin…");
  try {
    await new GarminClient({ apiKey: key }).verify();
  } catch (err) {
    out(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const path = await saveApiKey(key);
  out(`Saved to ${path} (only you can read it).\n`);
  out("Now add Paceva to your AI app:\n");
  out("  Claude Code:");
  out("    claude mcp add garmin -- npx -y github:OwenScheuer/paceva-garmin-mcp\n");
  out("  Claude Desktop, Cursor, VS Code and others: add this to the app's MCP servers:");
  out(`    "garmin": { "command": "npx", "args": ["-y", "github:OwenScheuer/paceva-garmin-mcp"] }\n`);
  out("Then ask: \"How did I sleep last night?\"");
}

async function check(): Promise<void> {
  const key = await findApiKey();
  if (!key) {
    console.error("No key found. Run: npx github:OwenScheuer/paceva-garmin-mcp setup");
    process.exitCode = 1;
    return;
  }
  const client = new GarminClient({ apiKey: key });
  const d = today();
  const summary = (await client.get("/usersummary-service/v2/dailysummaries", {
    startDate: d,
    endDate: d,
  })) as unknown;
  console.error(`Key works. Garmin answered for ${d}:`);
  console.error(JSON.stringify(summary).slice(0, 600));
}

const command = process.argv[2];
const run =
  command === "setup"
    ? setup
    : command === "check"
      ? check
      : command === "--version" || command === "-v"
        ? async () => console.log(VERSION)
        : command === "--help" || command === "-h" || command === "help"
          ? async () => console.log(HELP)
          : serve;

run().catch((err) => {
  console.error(err instanceof GarminError || err instanceof Error ? err.message : String(err));
  process.exit(1);
});
