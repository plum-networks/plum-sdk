// PlumClient keeping an OAuth connection alive: hourly access tokens, rotating
// refresh tokens, one refresh for many requests, and telling "signed out"
// (401 / invalid_grant) from "not allowed" (403).
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlumClient } from "../src/client.js";
import { PlumApiError, PlumAuthError, PlumForbiddenError } from "../src/errors.js";
import type { HttpAdapter, HttpRequest, HttpResponse } from "../src/http.js";
import type { OAuthTokens, TokenStorage } from "../src/types.js";

const BOX = "https://pb-x.plumbox.me";
const CLIENT_ID = "im.plum.obsidian-sync:obsidian";

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)).buffer as ArrayBuffer,
  };
}

/**
 * A box that follows the contract: one live access token and one live refresh
 * token at a time; a refresh rotates both. `refreshes` counts token-endpoint
 * calls; `failRefresh` makes the next refresh answer with that response.
 */
function fakeBox(opts: { access?: string; refresh?: string; appFolder?: boolean } = {}) {
  const state = {
    access: opts.access ?? "plum_pat_1",
    refresh: opts.refresh ?? "plum_rt_1",
    n: 1,
    refreshes: 0,
    failRefresh: null as HttpResponse | null,
    /** Hold token-endpoint replies until released (to line up concurrent requests). */
    gate: null as Promise<void> | null,
  };
  const seen: HttpRequest[] = [];
  const http: HttpAdapter = {
    async request(req) {
      seen.push(req);
      const url = new URL(req.url);
      if (url.pathname === "/api/oauth/token") {
        state.refreshes++;
        if (state.gate) await state.gate;
        if (state.failRefresh) return state.failRefresh;
        const body = JSON.parse(req.body as string) as Record<string, string>;
        if (body.grant_type !== "refresh_token" || body.client_id !== CLIENT_ID || body.refresh_token !== state.refresh) {
          return json(400, { error: "invalid_grant" });
        }
        state.n++;
        state.access = `plum_pat_${state.n}`;
        state.refresh = `plum_rt_${state.n}`;
        const out: Record<string, unknown> = {
          access_token: state.access,
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: state.refresh,
          scope: "files:app",
        };
        if (opts.appFolder !== false) out.app_folder = "/Apps/Obsidian Sync";
        return json(200, out);
      }
      if (req.headers?.["authorization"] !== `Bearer ${state.access}`) {
        return json(401, { error: "invalid_token" }, { "www-authenticate": 'Bearer error="invalid_token"' });
      }
      if (url.pathname === "/api/drive/list") {
        const path = url.searchParams.get("path") ?? "/";
        if (!path.startsWith("/Apps/Obsidian Sync")) return json(403, { error: "forbidden" });
        return json(200, { items: [], total: 0, limit: 1000, offset: 0 });
      }
      if (url.pathname === "/api/drive/upload") return json(200, { status: "ok", path: "/Apps/Obsidian Sync/a.md", name: "a.md" });
      if (url.pathname === "/api/drive/mkdir") {
        const b = JSON.parse(req.body as string) as { path: string; name: string };
        const full = `${b.path === "/" ? "" : b.path}/${b.name}`;
        if (!full.startsWith("/Apps/Obsidian Sync")) return json(403, { error: "forbidden" });
        if (full === "/Apps/Obsidian Sync") return json(409, { error: "exists" });
        return json(200, { status: "ok" });
      }
      return json(200, { user: { id: "u1" } });
    },
  };
  return { state, seen, http };
}

function client(http: HttpAdapter, extra: Partial<ConstructorParameters<typeof PlumClient>[0]> = {}) {
  return new PlumClient({
    baseUrl: BOX,
    token: "plum_pat_1",
    refreshToken: "plum_rt_1",
    expiresAt: Date.now() + 3600_000,
    clientId: CLIENT_ID,
    http,
    ...extra,
  });
}

const tokenCalls = (seen: HttpRequest[]) => seen.filter((r) => r.url.endsWith("/api/oauth/token"));

afterEach(() => {
  vi.useRealTimers();
});

describe("PlumClient refresh", () => {
  it("refreshes on a 401, sends the request again, and hands the rotated set to onTokens", async () => {
    const box = fakeBox();
    box.state.access = "plum_pat_expired_elsewhere"; // the box no longer takes plum_pat_1
    box.state.refresh = "plum_rt_1";
    const onTokens = vi.fn();
    const onAuthError = vi.fn();
    const c = client(box.http, { onTokens, onAuthError });
    await c.drive.list("/Apps/Obsidian Sync");
    expect(box.state.refreshes).toBe(1);
    expect(onAuthError).not.toHaveBeenCalled();
    const [tokens] = onTokens.mock.calls[0] as [OAuthTokens];
    expect(tokens).toMatchObject({
      accessToken: "plum_pat_2",
      refreshToken: "plum_rt_2",
      scope: "files:app",
      appFolder: "/Apps/Obsidian Sync",
      tokenType: "bearer",
    });
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
    const lists = box.seen.filter((r) => r.url.includes("/api/drive/list"));
    expect(lists.map((r) => r.headers?.["authorization"])).toEqual(["Bearer plum_pat_1", "Bearer plum_pat_2"]);
    expect(tokenCalls(box.seen)[0]!.url).toBe(`${BOX}/api/oauth/token`);
  });

  it("refreshes ahead of time when the access token has less than a minute left", async () => {
    const box = fakeBox();
    const onTokens = vi.fn();
    const c = client(box.http, { expiresAt: Date.now() + 30_000, onTokens });
    await c.auth.me();
    expect(box.state.refreshes).toBe(1);
    expect(box.seen.map((r) => new URL(r.url).pathname)).toEqual(["/api/oauth/token", "/api/auth/me"]);
    expect(box.seen[1]!.headers?.["authorization"]).toBe("Bearer plum_pat_2");
    expect(onTokens).toHaveBeenCalledOnce();
    // ...and not again while the new token is fresh.
    await c.auth.me();
    expect(box.state.refreshes).toBe(1);
  });

  it("four requests that all hit 401 share ONE refresh", async () => {
    const box = fakeBox();
    box.state.access = "plum_pat_rotated_away";
    let release!: () => void;
    box.state.gate = new Promise<void>((r) => (release = r));
    const c = client(box.http);
    const all = Promise.all([0, 1, 2, 3].map((i) => c.drive.list(`/Apps/Obsidian Sync/${i}`)));
    await vi.waitFor(() => expect(box.state.refreshes).toBe(1));
    release();
    await all;
    expect(box.state.refreshes).toBe(1);
    // A second refresh would have sent the rotated-away plum_rt_1 again — on a
    // real box, after the grace period, that ends the connection.
    expect(tokenCalls(box.seen)).toHaveLength(1);
  });

  it("a 401 that lands after another request already refreshed just retries", async () => {
    const box = fakeBox();
    box.state.access = "plum_pat_rotated_away";
    // Hold B's answer until A has had its 401, refreshed and retried.
    let releaseB!: () => void;
    const bGate = new Promise<void>((r) => (releaseB = r));
    const real = box.http.request.bind(box.http);
    box.http.request = async (req) => {
      if (req.url.includes("B")) await bGate;
      return real(req);
    };
    const c = client(box.http);
    const b = c.drive.list("/Apps/Obsidian Sync/B"); // goes out with plum_pat_1
    await c.drive.list("/Apps/Obsidian Sync/A"); // 401 → refresh → plum_pat_2
    releaseB(); // B's 401 (for plum_pat_1) arrives only now
    await b;
    expect(box.state.refreshes).toBe(1);
    const bs = box.seen.filter((r) => r.url.includes("B"));
    expect(bs.map((r) => r.headers?.["authorization"])).toEqual(["Bearer plum_pat_1", "Bearer plum_pat_2"]);
  });

  it("invalid_grant ends the connection: onAuthError once, every request fails, no more refreshes", async () => {
    const box = fakeBox();
    box.state.access = "plum_pat_rotated_away";
    box.state.failRefresh = json(400, { error: "invalid_grant" });
    const onAuthError = vi.fn();
    const onTokens = vi.fn();
    const c = client(box.http, { onAuthError, onTokens });
    const results = await Promise.allSettled([0, 1, 2, 3].map((i) => c.drive.list(`/Apps/Obsidian Sync/${i}`)));
    for (const r of results) {
      expect(r.status).toBe("rejected");
      const err = (r as PromiseRejectedResult).reason as PlumApiError;
      expect(err).toBeInstanceOf(PlumAuthError);
      expect(err.code === "invalid_grant" || err.status === 401).toBe(true);
    }
    expect(onAuthError).toHaveBeenCalledOnce();
    expect((onAuthError.mock.calls[0]![0] as PlumAuthError).code).toBe("invalid_grant");
    expect(onTokens).not.toHaveBeenCalled();
    expect(box.state.refreshes).toBe(1);
    await expect(c.drive.list("/Apps/Obsidian Sync")).rejects.toBeInstanceOf(PlumAuthError);
    expect(box.state.refreshes).toBe(1);
    expect(onAuthError).toHaveBeenCalledOnce();
  });

  it("a refresh that could not reach the box is not a sign-out: the next request tries again", async () => {
    const box = fakeBox();
    box.state.access = "plum_pat_rotated_away";
    box.state.failRefresh = json(503, { error: "unavailable" });
    const onAuthError = vi.fn();
    const c = client(box.http, { onAuthError });
    const err = await c.drive.list("/Apps/Obsidian Sync").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlumApiError);
    expect(err).not.toBeInstanceOf(PlumAuthError);
    expect(onAuthError).not.toHaveBeenCalled();
    box.state.failRefresh = null;
    await c.drive.list("/Apps/Obsidian Sync");
    expect(box.state.refreshes).toBe(2);
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it("goes ahead with a token that has a few seconds left when an early refresh fails", async () => {
    const box = fakeBox();
    box.state.failRefresh = json(503, { error: "unavailable" });
    const c = client(box.http, { expiresAt: Date.now() + 20_000 });
    await c.auth.me();
    expect(box.seen.map((r) => new URL(r.url).pathname)).toEqual(["/api/oauth/token", "/api/auth/me"]);
  });

  it("refreshes only once per request: a 401 after a good refresh is the end", async () => {
    const box = fakeBox();
    const onAuthError = vi.fn();
    const c = client(box.http, { onAuthError });
    // The box accepts neither the old token nor the refreshed one.
    box.state.access = "plum_pat_nothing_works";
    const real = box.http.request.bind(box.http);
    box.http.request = async (req) => {
      const res = await real(req);
      if (req.url.endsWith("/api/oauth/token")) box.state.access = "plum_pat_nothing_works";
      return res;
    };
    await expect(c.drive.list("/Apps/Obsidian Sync")).rejects.toBeInstanceOf(PlumAuthError);
    expect(box.state.refreshes).toBe(1);
    expect(onAuthError).toHaveBeenCalledOnce();
  });

  it("sends an upload body again byte for byte after the refresh", async () => {
    const box = fakeBox();
    box.state.access = "plum_pat_rotated_away";
    const c = client(box.http);
    await c.drive.upload("/Apps/Obsidian Sync/a.md", "hello", { overwrite: true });
    const uploads = box.seen.filter((r) => r.url.endsWith("/api/drive/upload"));
    expect(uploads).toHaveLength(2);
    expect(new Uint8Array(uploads[1]!.body as ArrayBuffer)).toEqual(new Uint8Array(uploads[0]!.body as ArrayBuffer));
    expect(uploads[1]!.headers?.["content-type"]).toBe(uploads[0]!.headers?.["content-type"]);
  });

  it("does not resend a body that cannot be read twice; says to send it again", async () => {
    const box = fakeBox();
    box.state.access = "plum_pat_rotated_away";
    const c = client(box.http);
    const stream = { notABuffer: true } as unknown as ArrayBuffer;
    const err = await c.request("/api/drive/upload", { method: "POST", body: stream }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlumApiError);
    expect(err).not.toBeInstanceOf(PlumAuthError);
    expect((err as PlumApiError).code).toBe("token_refreshed");
    expect(box.state.refreshes).toBe(1);
    expect(box.seen.filter((r) => r.url.endsWith("/api/drive/upload"))).toHaveLength(1);
    // The token is fresh now: the caller's second try goes through.
    await c.drive.list("/Apps/Obsidian Sync");
  });

  it("a 403 is not a reason to refresh or to sign out", async () => {
    const box = fakeBox();
    const onAuthError = vi.fn();
    const c = client(box.http, { onAuthError });
    await expect(c.drive.list("/Photos")).rejects.toBeInstanceOf(PlumForbiddenError);
    expect(box.state.refreshes).toBe(0);
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it("keeps the app folder when a refresh does not repeat it", async () => {
    const box = fakeBox({ appFolder: false });
    box.state.access = "plum_pat_rotated_away";
    const onTokens = vi.fn();
    const c = client(box.http, { appFolder: "/Apps/Obsidian Sync", onTokens });
    expect(c.appFolder).toBe("/Apps/Obsidian Sync");
    await c.drive.list("/Apps/Obsidian Sync");
    expect((onTokens.mock.calls[0]![0] as OAuthTokens).appFolder).toBe("/Apps/Obsidian Sync");
    expect(c.appFolder).toBe("/Apps/Obsidian Sync");
  });

  it("a refresh token alone refreshes before the first request", async () => {
    const box = fakeBox();
    const c = new PlumClient({ baseUrl: BOX, refreshToken: "plum_rt_1", clientId: CLIENT_ID, http: box.http });
    await c.auth.me();
    expect(box.seen.map((r) => new URL(r.url).pathname)).toEqual(["/api/oauth/token", "/api/auth/me"]);
  });

  it("refresh() refreshes now and shares a refresh in flight", async () => {
    const box = fakeBox();
    const c = client(box.http);
    await Promise.all([c.refresh(), c.refresh()]);
    expect(box.state.refreshes).toBe(1);
    await expect(new PlumClient({ baseUrl: BOX, token: "plum_pat_x", http: box.http }).refresh()).rejects.toThrow(
      /no refresh token/,
    );
  });

  it("drops a refresh result when the tokens were replaced meanwhile", async () => {
    const box = fakeBox();
    let release!: () => void;
    box.state.gate = new Promise<void>((r) => (release = r));
    const onTokens = vi.fn();
    const c = client(box.http, { onTokens });
    const p = c.refresh();
    await c.setToken({ accessToken: "plum_pat_new_signin", tokenType: "bearer", scope: "files:app" });
    release();
    await p;
    expect(onTokens).not.toHaveBeenCalled();
    box.state.access = "plum_pat_new_signin";
    await c.auth.me();
    expect(box.seen.at(-1)!.headers?.["authorization"]).toBe("Bearer plum_pat_new_signin");
  });

  it("adopts the result when storage hands back the very set the refresh rotated away", async () => {
    const box = fakeBox();
    let release!: () => void;
    box.state.gate = new Promise<void>((r) => (release = r));
    const onTokens = vi.fn();
    const c = client(box.http, { onTokens });
    const p = c.refresh();
    await c.setToken({ accessToken: "plum_pat_1", tokenType: "bearer", scope: "files:app", refreshToken: "plum_rt_1" });
    release();
    await p;
    expect(onTokens).toHaveBeenCalledOnce();
    await c.auth.me();
    expect(box.seen.at(-1)!.headers?.["authorization"]).toBe("Bearer plum_pat_2");
  });

  it("a request that starts while a refresh is under way waits for it", async () => {
    const box = fakeBox();
    box.state.access = "plum_pat_rotated_away";
    let release!: () => void;
    box.state.gate = new Promise<void>((r) => (release = r));
    const c = client(box.http);
    const first = c.drive.list("/Apps/Obsidian Sync/1");
    await vi.waitFor(() => expect(box.state.refreshes).toBe(1));
    const second = c.drive.list("/Apps/Obsidian Sync/2");
    release();
    await Promise.all([first, second]);
    const seconds = box.seen.filter((r) => r.url.includes("%2F2"));
    expect(seconds.map((r) => r.headers?.["authorization"])).toEqual(["Bearer plum_pat_2"]);
  });

  it("an old never-expiring token (no refresh token) is never refreshed", async () => {
    const box = fakeBox();
    box.state.access = "plum_pat_revoked";
    const onAuthError = vi.fn();
    const c = new PlumClient({ baseUrl: BOX, token: "plum_pat_legacy", http: box.http, onAuthError });
    await expect(c.auth.me()).rejects.toBeInstanceOf(PlumAuthError);
    expect(box.state.refreshes).toBe(0);
    expect(onAuthError).toHaveBeenCalledOnce();
  });

  it("refuses a refresh token it could not use safely", () => {
    const tok = { token: "plum_pat_1", refreshToken: "plum_rt_1" };
    expect(() => new PlumClient({ baseUrl: BOX, ...tok })).toThrow(/clientId/);
    expect(() => new PlumClient({ baseUrl: "http://192.168.0.10:8443", clientId: CLIENT_ID, ...tok })).toThrow(/verified iss/);
    expect(() => new PlumClient({ baseUrl: BOX + "/", clientId: CLIENT_ID, ...tok })).not.toThrow();
    expect(() => new PlumClient({ baseUrl: BOX, iss: "https://pb-x-lan.plumbox.me", clientId: CLIENT_ID, ...tok })).toThrow(
      /verified iss/,
    );
  });

  it("refreshes at the iss, not at a LAN baseUrl", async () => {
    const box = fakeBox();
    box.state.access = "plum_pat_rotated_away";
    const c = client(box.http, { baseUrl: "http://192.168.0.10:8443", iss: BOX });
    await c.drive.list("/Apps/Obsidian Sync");
    expect(tokenCalls(box.seen).map((r) => r.url)).toEqual([`${BOX}/api/oauth/token`]);
    expect(box.seen.at(-1)!.url.startsWith("http://192.168.0.10:8443/api/drive/list")).toBe(true);
  });
});

describe("PlumClient tokenStorage", () => {
  function memory(initial: Record<string, string> = {}): TokenStorage & { data: Record<string, string> } {
    const data = { ...initial };
    return {
      data,
      async get(k) {
        return data[k] ?? null;
      },
      async set(k, v) {
        data[k] = v;
      },
      async delete(k) {
        delete data[k];
      },
    };
  }

  it("still loads a bare token saved by 0.3", async () => {
    const box = fakeBox({ access: "plum_pat_legacy" });
    const tokenStorage = memory({ "plumbox.token": "plum_pat_legacy" });
    const c = new PlumClient({ baseUrl: BOX, http: box.http, tokenStorage });
    expect(await c.loadToken()).toBe(true);
    await c.auth.me();
    expect(box.seen[0]!.headers?.["authorization"]).toBe("Bearer plum_pat_legacy");
  });

  it("stores the whole set as JSON and keeps it current across refreshes", async () => {
    const box = fakeBox();
    const tokenStorage = memory();
    const c = new PlumClient({ baseUrl: BOX, clientId: CLIENT_ID, http: box.http, tokenStorage });
    await c.setToken({
      accessToken: "plum_pat_1",
      tokenType: "bearer",
      scope: "files:app",
      refreshToken: "plum_rt_1",
      expiresAt: Date.now() + 3600_000,
      appFolder: "/Apps/Obsidian Sync",
    });
    expect(JSON.parse(tokenStorage.data["plumbox.token"]!)).toMatchObject({ accessToken: "plum_pat_1", refreshToken: "plum_rt_1" });
    box.state.access = "plum_pat_rotated_away";
    await c.drive.list("/Apps/Obsidian Sync");
    const saved = JSON.parse(tokenStorage.data["plumbox.token"]!) as OAuthTokens;
    expect(saved).toMatchObject({ accessToken: "plum_pat_2", refreshToken: "plum_rt_2", appFolder: "/Apps/Obsidian Sync" });

    const again = new PlumClient({ baseUrl: BOX, clientId: CLIENT_ID, http: box.http, tokenStorage });
    expect(await again.loadToken()).toBe(true);
    expect(again.appFolder).toBe("/Apps/Obsidian Sync");
    await again.auth.me();
    expect(box.seen.at(-1)!.headers?.["authorization"]).toBe("Bearer plum_pat_2");
  });

  it("a PAT string is stored as before", async () => {
    const tokenStorage = memory();
    const c = new PlumClient({ baseUrl: BOX, tokenStorage });
    await c.setToken("plum_pat_x");
    expect(tokenStorage.data["plumbox.token"]).toBe("plum_pat_x");
    await c.clearToken();
    expect(tokenStorage.data).toEqual({});
    expect(c.hasToken).toBe(false);
  });
});

describe("drive.ensureDir with a files:app token", () => {
  it("passes over the parents it may not touch and creates what is inside its folder", async () => {
    const box = fakeBox();
    const c = client(box.http);
    await c.drive.ensureDir("/Apps/Obsidian Sync/MyVault/notes");
    const made = box.seen
      .filter((r) => r.url.endsWith("/api/drive/mkdir"))
      .map((r) => JSON.parse(r.body as string) as { path: string; name: string });
    expect(made.map((m) => `${m.path}|${m.name}`)).toEqual([
      "/|Apps",
      "/Apps|Obsidian Sync",
      "/Apps/Obsidian Sync|MyVault",
      "/Apps/Obsidian Sync/MyVault|notes",
    ]);
  });

  it("still fails when the folder itself is out of bounds", async () => {
    const box = fakeBox();
    const c = client(box.http);
    await expect(c.drive.ensureDir("/Photos/2026")).rejects.toBeInstanceOf(PlumForbiddenError);
  });
});
