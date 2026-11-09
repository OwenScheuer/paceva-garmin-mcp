// Starts the MCP server the way an AI app does and checks it lists its tools.
// Usage: node scripts/smoke.mjs <path to index.js>. Needs no real Garmin key.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const entry = process.argv[2];
if (!entry) throw new Error("Usage: node scripts/smoke.mjs <path to index.js>");

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, GARMIN_PERSONAL_API_KEY: "not-a-real-key" },
});
const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const fail = (why) => {
  console.error(`Smoke test failed: ${why}`);
  child.kill();
  process.exit(1);
};
const timer = setTimeout(() => fail("no answer within 30 seconds"), 30_000);
child.on("exit", (code) => fail(`server exited early with code ${code}`));

createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) {
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
  }
  if (message.id === 2) {
    const count = message.result?.tools?.length ?? 0;
    if (count === 0) fail("the server listed no tools");
    console.log(`OK: ${message.result.tools.length} tools`);
    clearTimeout(timer);
    child.removeAllListeners("exit");
    child.kill();
    process.exit(0);
  }
});

send({
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  },
});
