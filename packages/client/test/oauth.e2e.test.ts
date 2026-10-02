// End to end against a C1 core running as an emulator (oauth-issuer.v3.md
// §11.1). Opt-in; nothing here runs in `npm test` unless PLUM_OAUTH_E2E=1.
//
// 1. Build and run core HEAD (with C1, the issuer-binding change) as an
//    emulator on plain HTTP:
//      PLUMBOX_EMULATOR=1 ./build/plum-server -port 8080 -data-dir <d> -storage-dir <s>
//    It seeds the owner dev@plum.local / plumbox-dev.
// 2. Install the Bridge Check example, whose manifest declares the client
//    dev.plum.bridgecheck:test (redirects http://127.0.0.1/cb, bridgecheck://cb):
//      plum-dev emulator login
//      plum-dev push examples/bridge-check --target emulator
// 3. From the repo root:
//      PLUM_OAUTH_E2E=1 npm run test:e2e --workspace @plumbox/client
//    Overrides: PLUM_E2E_BOX (default http://127.0.0.1:8080),
//    PLUM_E2E_LOGIN / PLUM_E2E_PASSWORD (default the seeded owner).
//
// Against a C0 core (no binding) steps 5, 8 and 9 fail by design: the island
// has no iss, and the box ignores the DPoP header.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchAdapter } from "../src/adapters/fetch.js";
import {
  completeAuthorization,
  startAuthorization,
  validateCallback,
  type PendingAuthorization,
} from "../src/authorize.js";
import { PlumClient } from "../src/client.js";
import { createDPoPProof, generateDPoPKey } from "../src/dpop.js";
import { PlumApiError } from "../src/errors.js";
import type { HttpAdapter, HttpRequest } from "../src/http.js";
import { parseSessionCookie, responseJSON, responseText } from "../src/http.js";
import { beginAuthorization, exchangeCode } from "../src/oauth.js";

const enabled = process.env.PLUM_OAUTH_E2E === "1";
const BOX = (process.env.PLUM_E2E_BOX ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const LOGIN = process.env.PLUM_E2E_LOGIN ?? "dev@plum.local";
const PASSWORD = process.env.PLUM_E2E_PASSWORD ?? "plumbox-dev";
const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "examples", "bridge-check", "manifest.json"), "utf8"),
) as { clients: { client_id: string }[] };
const CLIENT_ID = manifest.clients[0]!.client_id; // dev.plum.bridgecheck:test
const REDIRECT = "http://127.0.0.1:53682/cb"; // registered as http://127.0.0.1/cb; loopback matches any port
const TOKEN_URL = BOX + "/api/oauth/token";

let cookie = "";

async function login(): Promise<string> {
  const res = await fetchAdapter
    .request({
      url: BOX + "/api/auth/login",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
    })
    .catch((e: unknown) => {
      throw new Error(`cannot reach the emulator at ${BOX} (${String(e)}); see the header of this file`);
    });
  if (res.status !== 200) throw new Error(`login ${res.status}: ${responseText(res)} (is the emulator up at ${BOX}?)`);
  const c = parseSessionCookie(res.headers["set-cookie"]);
  if (!c) throw new Error("login: no session cookie (TOTP enabled on the owner?)");
  return c;
}

/** What the consent page and its Allow button do in the user's browser. */
async function consent(entryUrl: string): Promise<{ island: Record<string, unknown>; code: string; iss: string }> {
  const u = new URL(entryUrl);
  // The user's browser lands on the box's /authorize (Dev starts there; the
  // relay attack below starts elsewhere and the browser still ends here).
  const page = await fetch(BOX + "/authorize" + u.search, { headers: { cookie }, redirect: "manual" });
  const html = await page.text();
  if (page.status !== 200) throw new Error(`consent page ${page.status} (session missing or stale?)`);
  const m = /<script type="application\/json" id="p">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error(`no consent island; is ${CLIENT_ID} installed? (plum-dev push examples/bridge-check --target emulator)\n${html.slice(0, 400)}`);
  const island = JSON.parse(m[1]!) as Record<string, unknown>;
  const res = await fetchAdapter.request({
    url: BOX + "/api/oauth/authorize",
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(island),
  });
  if (res.status !== 200) throw new Error(`authorize ${res.status}: ${responseText(res)}`);
  const d = responseJSON<{ code: string; iss?: string }>(res);
  return { island, code: d.code, iss: d.iss ?? "" };
}

/** The redirect the consent script builds: code, iss, state. */
const callbackUrl = (p: PendingAuthorization, code: string, iss: string): string =>
  `${REDIRECT}?code=${encodeURIComponent(code)}&iss=${encodeURIComponent(iss)}&state=${encodeURIComponent(p.state)}`;

const startDev = (issuer = BOX): Promise<PendingAuthorization> =>
  startAuthorization({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    scopes: ["files:read"],
    expectation: { mode: "dev", issuer },
    policy: { allowDev: true },
  });

/** A fresh, honestly-bound authorized outcome for the emulator. */
async function authorizedAtBox() {
  const pending = await startDev();
  const { code, iss } = await consent(pending.url);
  const outcome = validateCallback(pending, callbackUrl(pending, code, iss));
  expect(outcome).toEqual({ kind: "authorized", issuer: BOX, match: "dev" });
  return { pending, outcome, code };
}

/** An adapter that records the requests it forwards (what an attacker in the path sees). */
function recording(rewrite: (req: HttpRequest) => Promise<HttpRequest> | HttpRequest = (r) => r) {
  const seen: HttpRequest[] = [];
  const adapter: HttpAdapter = {
    async request(req) {
      const out = await rewrite(req);
      seen.push(out);
      return fetchAdapter.request(out);
    },
  };
  return { adapter, seen };
}

/** Redeem `body` again without a proof: invalid_grant means the code was already burned. */
async function redeemAgain(body: HttpRequest["body"]): Promise<string | undefined> {
  const res = await fetchAdapter.request({ url: TOKEN_URL, method: "POST", headers: { "content-type": "application/json" }, body });
  return res.status === 200 ? "accepted" : responseJSON<{ error?: string }>(res).error;
}

const dpopHeader = (req: HttpRequest): string | undefined =>
  Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === "dpop")?.[1];

describe.runIf(enabled)(`oauth e2e against ${BOX}`, () => {
  let relay: Server;
  let relayOrigin = "";

  beforeAll(async () => {
    cookie = await login();
    // A second local server that relays whatever it receives to the real box:
    // the attacker's "pb-evil" for step 8.
    relay = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        const dpop = req.headers["dpop"];
        if (typeof dpop === "string") headers["DPoP"] = dpop;
        fetch(BOX + (req.url ?? "/"), { method: req.method, headers, body: req.method === "POST" ? body : undefined })
          .then(async (r) => {
            res.writeHead(r.status, { "content-type": "application/json" });
            res.end(await r.text());
          })
          .catch((e: unknown) => {
            res.writeHead(502);
            res.end(String(e));
          });
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    relayOrigin = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (relay?.listening) await new Promise((resolve) => relay.close(resolve));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("4-7: Dev sign-in, bound code, token works", async () => {
    const pending = await startDev();
    const jkt = new URL(pending.url).searchParams.get("dpop_jkt");
    expect(pending.url.startsWith(BOX + "/authorize?")).toBe(true);
    const { island, code, iss } = await consent(pending.url);
    expect(island.iss).toBe(BOX); // EmulatorIssuer: http:// + Host
    expect(island.dpop_jkt).toBe(jkt);
    expect(iss).toBe(BOX);
    const outcome = validateCallback(pending, callbackUrl(pending, code, iss));
    expect(outcome).toEqual({ kind: "authorized", issuer: BOX, match: "dev" });
    const grant = await completeAuthorization(outcome);
    expect(grant).toMatchObject({ tokenType: "bearer", issuer: BOX });
    const me = await new PlumClient({ baseUrl: grant.issuer, token: grant.accessToken }).auth.me();
    expect(me).toBeTruthy();
  });

  it("8a: an app fooled into the relay's issuer: the box refuses the relayed proof and burns the code", async () => {
    // A1 rewrote iss to its own server; the app's Dev expectation names that
    // server, so the app accepts it and exchanges there, signing for it.
    const pending = await startDev(relayOrigin);
    const { code } = await consent(pending.url); // the user's browser really was at the box
    const outcome = validateCallback(pending, callbackUrl(pending, code, relayOrigin));
    expect(outcome).toEqual({ kind: "authorized", issuer: relayOrigin, match: "dev" });
    const { adapter, seen } = recording();
    const err = await completeAuthorization(outcome, { http: adapter }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlumApiError);
    expect((err as PlumApiError).code).toBe("invalid_dpop_proof");
    expect(seen.map((r) => r.url)).toEqual([relayOrigin + "/api/oauth/token"]);
    expect(await redeemAgain(seen[0]!.body)).toBe("invalid_grant"); // burned
  });

  it("8b: the proof stripped → invalid_dpop_proof, code burned", async () => {
    const { outcome } = await authorizedAtBox();
    const { adapter, seen } = recording((req) => ({
      ...req,
      headers: Object.fromEntries(Object.entries(req.headers ?? {}).filter(([k]) => k.toLowerCase() !== "dpop")),
    }));
    await expect(completeAuthorization(outcome, { http: adapter })).rejects.toMatchObject({ code: "invalid_dpop_proof" });
    expect(dpopHeader(seen[0]!)).toBeUndefined();
    expect(await redeemAgain(seen[0]!.body)).toBe("invalid_grant");
  });

  it("8c: re-signed with another key → invalid_grant", async () => {
    const { outcome } = await authorizedAtBox();
    const other = await generateDPoPKey(false);
    const { adapter } = recording(async (req) => ({
      ...req,
      headers: { "content-type": "application/json", DPoP: await createDPoPProof(other, TOKEN_URL, Math.floor(Date.now() / 1000)) },
    }));
    await expect(completeAuthorization(outcome, { http: adapter })).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("9: a proof an hour old → plum_retry iat + plum_server_time, then the same code succeeds", async () => {
    const { outcome, code } = await authorizedAtBox();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 3600_000); // the phone's clock
    const answers: { status: number; body: Record<string, unknown> }[] = [];
    const sent: HttpRequest[] = [];
    const adapter: HttpAdapter = {
      async request(req) {
        sent.push(req);
        const res = await fetchAdapter.request(req);
        answers.push({ status: res.status, body: responseJSON<Record<string, unknown>>(res) });
        return res;
      },
    };
    const grant = await completeAuthorization(outcome, { http: adapter });
    expect(grant.issuer).toBe(BOX);
    expect(answers).toHaveLength(2);
    expect(answers[0]).toMatchObject({ status: 400, body: { error: "invalid_dpop_proof", plum_retry: "iat" } });
    expect(typeof answers[0]!.body.plum_server_time).toBe("number");
    expect(sent.map((r) => (JSON.parse(String(r.body)) as { code: string }).code)).toEqual([code, code]);
  });

  it("10: the legacy flow (no dpop_jkt, custom scheme) still gets a token while the cutoff is unset", async () => {
    const req = await beginAuthorization({
      clientId: CLIENT_ID,
      redirectUri: "bridgecheck://cb",
      scopes: ["files:read"],
      portalUrl: BOX,
    });
    const { island, code } = await consent(req.url);
    expect(island.dpop_jkt ?? "").toBe("");
    const { accessToken } = await exchangeCode({
      baseUrl: BOX,
      code,
      codeVerifier: req.codeVerifier,
      clientId: CLIENT_ID,
      redirectUri: "bridgecheck://cb",
    });
    expect(await new PlumClient({ baseUrl: BOX, token: accessToken }).auth.me()).toBeTruthy();
  });
});

describe.runIf(!enabled)("oauth e2e (skipped)", () => {
  it("set PLUM_OAUTH_E2E=1 with a C1 emulator running (see the header of this file)", () => {
    expect(true).toBe(true);
  });
});
