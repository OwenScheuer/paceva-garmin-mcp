/** A stand-in for Garmin's Personal API, recording every request. */

export function jwt(expiresInSec: number, now = Date.now()): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ exp: Math.floor(now / 1000) + expiresInSec })}.sig`;
}

export type FakeOptions = {
  validKey?: string;
  routes?: Record<string, unknown>;
  /** Status to return for data calls, e.g. 429. */
  dataStatus?: number;
  /** Reject the first N bearer tokens with 401 (as if revoked). */
  revokeFirst?: number;
};

export function fakeGarmin(opts: FakeOptions = {}) {
  const validKey = opts.validKey ?? "good-key";
  const calls: { method: string; path: string; search: string; auth: string }[] = [];
  let issued = 0;
  let revoke = opts.revokeFirst ?? 0;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search, auth });

    if (url.pathname.endsWith("/personal-api-key/token")) {
      if (auth !== `ApiKey ${validKey}`) return new Response("bad key", { status: 401 });
      issued += 1;
      return new Response(jwt(24 * 3600), { status: 200 });
    }
    if (!auth.startsWith("Bearer ")) return new Response("", { status: 401 });
    if (revoke > 0) {
      revoke -= 1;
      return new Response("", { status: 401 });
    }
    if (opts.dataStatus) return new Response("nope", { status: opts.dataStatus });
    const body = opts.routes?.[url.pathname];
    if (body === undefined) return new Response("", { status: 200 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, calls, issued: () => issued };
}
