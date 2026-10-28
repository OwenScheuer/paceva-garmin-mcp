import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A small client for Garmin's Connect Personal API. It reads only the
 * signed-in person's own data, which is what Garmin issues personal keys for.
 *
 * The key is found the same way Garmin's own client finds it (the
 * GARMIN_PERSONAL_API_KEY variable, then ~/.config/garmin/connect-personal-api-key),
 * and exchanged for a bearer token that lasts up to 24 hours. That token is
 * cached on disk, readable only by you, so a new chat doesn't ask Garmin again.
 */

export const DEFAULT_BASE_URL = "https://personal.connectapi.garmin.com";
export const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
export const KEY_ENV = "GARMIN_PERSONAL_API_KEY";
export const KEY_PAGE = "https://connect.garmin.com/app/settings/personalApiToken";

export const keyFile = () => join(homedir(), ".config", "garmin", "connect-personal-api-key");
export const tokenCacheFile = () => join(homedir(), ".config", "paceva-garmin", "token.json");

/** Renew the bearer token when it has less than this left. */
const REFRESH_WINDOW_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 30_000;

export class GarminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GarminError";
  }
}

/** The key from the environment, else from Garmin's default key file, else null. */
export async function findApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const fromEnv = env[KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = (await readFile(keyFile(), "utf8")).trim();
    return fromFile || null;
  } catch {
    return null;
  }
}

/** Save a key where Garmin's own tools also look for it, readable only by you. */
export async function saveApiKey(key: string): Promise<string> {
  const path = keyFile();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${key.trim()}\n`, { mode: 0o600 });
  return path;
}

type CachedToken = { fingerprint: string; accessToken: string; expiresAt: number };

/** When a JWT expires, in ms since the epoch. Garmin's tokens always carry `exp`. */
export function jwtExpiry(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) throw new GarminError("Garmin returned a token Paceva can't read.");
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: number;
    };
    if (typeof exp !== "number") throw new Error("no exp");
    return exp * 1000;
  } catch {
    throw new GarminError("Garmin returned a token Paceva can't read.");
  }
}

export type GarminClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Where to cache the bearer token; null keeps it in memory only. */
  cacheFile?: string | null;
  now?: () => number;
};

export class GarminClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheFile: string | null;
  private readonly now: () => number;
  private readonly fingerprint: string;
  private token: CachedToken | null = null;
  private pending: Promise<string> | null = null;

  constructor(opts: GarminClientOptions) {
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? process.env.GARMIN_PERSONAL_API_BASE_URL ?? DEFAULT_BASE_URL)
      .replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.cacheFile = opts.cacheFile === undefined ? tokenCacheFile() : opts.cacheFile;
    this.now = opts.now ?? Date.now;
    // The cache only serves the key (and server) it was made for.
    this.fingerprint = createHash("sha256").update(`${this.baseUrl}\0${this.apiKey}`).digest("hex");
  }

  /** GET a path and return its JSON, or null when Garmin sends an empty body. */
  async get(path: string, params?: Record<string, string | number | undefined>): Promise<unknown> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) query.set(k, String(v));
    const url = `${this.baseUrl}${path}${query.size ? `?${query}` : ""}`;

    let res = await this.send(url, await this.bearer());
    if (res.status === 401) {
      // The token may have been revoked early; one fresh exchange, then give up.
      this.token = null;
      res = await this.send(url, await this.bearer(true));
    }
    if (!res.ok) throw await httpError(res, path);
    const text = await res.text();
    return text.trim() ? JSON.parse(text) : null;
  }

  /** Exchange the key now, to check it works. */
  async verify(): Promise<void> {
    await this.bearer(true);
  }

  private async send(url: string, bearer: string): Promise<Response> {
    return this.fetchImpl(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  private async bearer(force = false): Promise<string> {
    if (!force) {
      const fresh = (t: CachedToken | null) =>
        t && t.fingerprint === this.fingerprint && t.expiresAt - this.now() > REFRESH_WINDOW_MS;
      if (fresh(this.token)) return this.token!.accessToken;
      const cached = await this.readCache();
      if (fresh(cached)) {
        this.token = cached;
        return cached!.accessToken;
      }
    }
    // Several tools may start at once; they share one exchange.
    this.pending ??= this.exchange().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async exchange(): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}${TOKEN_PATH}`, {
      method: "POST",
      headers: { Accept: "*/*", Authorization: `ApiKey ${this.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      throw new GarminError(
        `Garmin didn't accept your Personal API key. It may have expired or been deleted. Create a new one at ${KEY_PAGE}, then run \`npx github:OwenScheuer/paceva-garmin-mcp --new-key\` in a terminal again.`,
        res.status,
      );
    }
    if (!res.ok) throw await httpError(res, TOKEN_PATH);
    const accessToken = (await res.text()).trim();
    this.token = { fingerprint: this.fingerprint, accessToken, expiresAt: jwtExpiry(accessToken) };
    await this.writeCache(this.token);
    return accessToken;
  }

  private async readCache(): Promise<CachedToken | null> {
    if (!this.cacheFile) return null;
    try {
      const data = JSON.parse(await readFile(this.cacheFile, "utf8")) as CachedToken;
      return typeof data.accessToken === "string" && typeof data.expiresAt === "number"
        ? data
        : null;
    } catch {
      return null;
    }
  }

  private async writeCache(token: CachedToken): Promise<void> {
    if (!this.cacheFile) return;
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      await writeFile(this.cacheFile, JSON.stringify(token), { mode: 0o600 });
    } catch {
      // A cache that can't be written only costs an extra exchange next time.
    }
  }
}

async function httpError(res: Response, path: string): Promise<GarminError> {
  const body = (await res.text().catch(() => "")).trim().slice(0, 300);
  if (res.status === 429) {
    return new GarminError("Garmin is rate-limiting requests right now. Try again in a minute.", 429);
  }
  if (res.status === 404) {
    return new GarminError(`Garmin has nothing at ${path} for that date or ID.`, 404);
  }
  if (res.status >= 500) {
    return new GarminError(`Garmin's servers returned an error (${res.status}). Try again shortly.`, res.status);
  }
  return new GarminError(`Garmin returned ${res.status} for ${path}${body ? `: ${body}` : ""}`, res.status);
}
