#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findApiKey, GarminClient, GarminError, KEY_PAGE, saveApiKey } from "./garmin.js";
import { askHidden, install, PACKAGE } from "./install.js";
import { INSTRUCTIONS, registerTools, today } from "./tools.js";
import { VERSION } from "./version.js";

const HELP = `paceva-garmin-mcp ${VERSION}
Your own Garmin Connect data in Claude and other MCP apps. Free, local, read-only.

  npx ${PACKAGE}              Set everything up (run it in a terminal)
  npx ${PACKAGE} --new-key    Set up again with a new Garmin key
  npx ${PACKAGE} check        Check the saved key and show today's numbers
  npx ${PACKAGE} key          Save a key piped in, without adding to any app

When an AI app starts it, it runs the MCP server instead.
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
  if (!key) console.error(`paceva-garmin-mcp: no API key yet. Run in a terminal: npx github:OwenScheuer/paceva-garmin-mcp`);
}

async function check(): Promise<void> {
  const key = await findApiKey();
  if (!key) {
    console.error("No key found. Run in a terminal: npx github:OwenScheuer/paceva-garmin-mcp");
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

/** Save a key without touching any app: `pbpaste | npx … key`. */
async function saveKey(): Promise<void> {
  const key = await askHidden("Garmin Personal API key: ");
  if (!key) throw new Error("No key given; nothing saved.");
  await new GarminClient({ apiKey: key }).verify();
  console.error(`Saved to ${await saveApiKey(key)} (only you can read it).`);
}

const command = process.argv[2];
// Run by hand in a terminal, it sets things up; run by an AI app (pipes, not
// a terminal), it's the MCP server.
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const run =
  command === "setup" || command === "install"
    ? () => install()
    : command === "--new-key"
      ? () => install({ newKey: true })
      : command === "key"
        ? saveKey
        : command === "check"
          ? check
          : command === "--version" || command === "-v"
            ? async () => console.log(VERSION)
            : command === "--help" || command === "-h" || command === "help"
              ? async () => console.log(HELP)
              : !command && interactive
                ? () => install()
                : serve;

run().catch((err) => {
  console.error(err instanceof GarminError || err instanceof Error ? err.message : String(err));
  process.exit(1);
});
