// The bound sign-in (oauth-issuer.v3.md §5): start cases, channel derivation
// and every callback case of the shared v3 vectors, plus the properties the
// JS entry points must keep (the integrator cannot choose the channel or forge
// an authorized outcome; a stray callback cannot cancel a sign-in).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptIssuerChange,
  completeAuthorization,
  deserializePendingAuthorization,
  discardPendingAuthorization,
  serializePendingAuthorization,
  startAuthorization,
  validateCallback,
  validateCallbackParams,
  type AuthorizationOutcome,
  type IssuerExpectation,
  type PendingAuthorization,
} from "../src/authorize.js";
import { PlumOAuthError } from "../src/errors.js";
import {
  channelForCallbackURL,
  channelForRedirect,
  rawQueryOf,
  redirectMatches,
  startError,
  validate,
  type Channel,
  type Result,
  type Txn,
} from "../src/internal/callback.js";
import { fakeBox, fromEntryURL } from "./support/fake-box.js";
import { vectors, type CallbackCase, type CallbackStep, type StartCase } from "./support/vectors.js";

const NOW_MS = vectors.now_unix * 1000;
const LOOPBACK = "http://127.0.0.1:53682/callback";
const CUSTOM = "plumsample://auth/callback";
const BOX = "https://pb-1234.plumbox.me";
const OTHER = "https://pb-5678.plumbox.me";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A vector step's expectation shape, from a public outcome. */
function shapeOf(o: AuthorizationOutcome): CallbackStep["expect"] {
  switch (o.kind) {
    case "authorized":
      return { outcome: o.kind, reason: "", issuer: o.issuer, match: o.match };
    case "issuer_changed":
      return { outcome: o.kind, reason: "", issuer: o.issuer, match: "" };
    case "denied":
      return { outcome: o.kind, reason: o.error, issuer: "", match: "" };
    default:
      return { outcome: o.kind, reason: o.reason, issuer: "", match: "" };
  }
}

/** The same, from an internal validate() result. */
function shapeOfResult(r: Result): CallbackStep["expect"] {
  switch (r.outcome) {
    case "authorized":
      return { outcome: r.outcome, reason: "", issuer: r.issuer, match: r.match };
    case "issuer_changed":
      return { outcome: r.outcome, reason: "", issuer: r.issuer, match: "" };
    case "denied":
      return { outcome: r.outcome, reason: r.error, issuer: "", match: "" };
    default:
      return { outcome: r.outcome, reason: r.reason, issuer: "", match: "" };
  }
}

function expectationOf(e: StartCase["expectation"]): IssuerExpectation {
  return e.mode === "discover" ? { mode: "discover" } : { mode: e.mode, issuer: e.issuer! };
}

const start = (
  redirectUri: string,
  expectation: IssuerExpectation = { mode: "discover" },
  policy: Parameters<typeof startAuthorization>[0]["policy"] = {},
  persistable = false,
): Promise<PendingAuthorization> =>
  startAuthorization({ clientId: "im.plum.downloader:sample", redirectUri, scopes: ["files:read"], expectation, policy, persistable });

// ---------------------------------------------------------------- start_cases

describe("start_cases", () => {
  it("has the 8 cases of v3", () => expect(vectors.start_cases).toHaveLength(8));

  // The vector names the Android/iOS channel; JS derives the channel from the
  // redirect URI, so a verified vector channel runs on a loopback redirect
  // and an unverified one on a custom scheme. Start only asks "verified?".
  it.each(vectors.start_cases.map((c) => [c.name, c] as const))("public startAuthorization: %s", async (_n, c) => {
    const verified = c.channel === "auth_tab" || c.channel === "as_web_auth" || c.channel === "loopback";
    const run = start(verified ? LOOPBACK : CUSTOM, expectationOf(c.expectation), {
      boxDomain: c.policy.box_domain,
      requireVerifiedChannel: c.policy.require_verified_channel,
      allowDev: true,
    });
    if (!c.expect.ok) {
      await expect(run).rejects.toBeInstanceOf(PlumOAuthError);
      await expect(run).rejects.toMatchObject({ code: c.expect.error });
      return;
    }
    const p = await run;
    expect(p.url.startsWith(c.expect.entry_prefix!)).toBe(true);
    const u = new URL(p.url);
    expect(u.hash).toBe(c.expect.fragment ? "#" + c.expect.fragment : "");
    expect(u.searchParams.get("dpop_jkt")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("state")).toBe(p.state);
    expect(p.channel).toBe(verified ? "loopback" : "external");
  });

  it.each(vectors.start_cases.map((c) => [c.name, c] as const))("internal start rule, exact channel: %s", (_n, c) => {
    const e = c.expectation.mode === "discover" ? { mode: "discover" as const, issuer: "" } : { mode: c.expectation.mode, issuer: c.expectation.issuer! };
    const err = startError(e, c.channel, { boxDomain: c.policy.box_domain, requireVerifiedChannel: c.policy.require_verified_channel });
    expect(err).toBe(c.expect.ok ? null : c.expect.error);
  });

  it("sends the 7 standard params plus dpop_jkt, and the box hint only for Known", async () => {
    const want = ["client_id", "code_challenge", "code_challenge_method", "dpop_jkt", "redirect_uri", "response_type", "scope", "state"];
    for (const [exp, hash] of [
      [{ mode: "discover" }, ""],
      [{ mode: "known", issuer: BOX }, "#box=pb-1234"],
      [{ mode: "dev", issuer: "http://10.0.2.2:8080" }, ""],
    ] as const) {
      const p = await start(LOOPBACK, exp, { allowDev: true });
      const u = new URL(p.url);
      expect([...u.searchParams.keys()].sort(), exp.mode).toEqual(want);
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.has("client_name")).toBe(false);
      expect(u.hash, exp.mode).toBe(hash);
    }
  });

  it("refuses Dev unless policy.allowDev is exactly true (debug builds only)", async () => {
    const dev = { mode: "dev", issuer: "http://10.0.2.2:8080" } as const;
    await expect(start(LOOPBACK, dev)).rejects.toMatchObject({ code: "dev_not_allowed" });
    await expect(start(LOOPBACK, dev, { allowDev: "yes" as unknown as boolean })).rejects.toMatchObject({
      code: "dev_not_allowed",
    });
    await expect(start(LOOPBACK, { mode: "dev", issuer: "http://8.8.8.8:8080" }, { allowDev: true })).rejects.toMatchObject({
      code: "invalid_dev_issuer",
    });
  });

  it("opts out of the verified channel only on an explicit false", async () => {
    await expect(start(CUSTOM, { mode: "discover" }, { requireVerifiedChannel: 0 as unknown as boolean })).rejects.toMatchObject({
      code: "verified_channel_unavailable",
    });
    await expect(start(CUSTOM, { mode: "discover" }, { requireVerifiedChannel: false })).resolves.toBeTruthy();
  });

  it("requires clientId, scopes, redirectUri and a known expectation mode", async () => {
    await expect(startAuthorization({ clientId: " ", redirectUri: LOOPBACK, scopes: ["files:read"] })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(startAuthorization({ clientId: "x", redirectUri: LOOPBACK, scopes: [] })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(startAuthorization({ clientId: "x", redirectUri: "", scopes: ["files:read"] })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      start(LOOPBACK, { mode: "known" } as unknown as IssuerExpectation),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("uses a fresh state, verifier and key per attempt, and honours portalUrl", async () => {
    const a = await startAuthorization({ clientId: "x", redirectUri: LOOPBACK, scopes: ["files:read"], portalUrl: "https://portal.test/" });
    const b = await start(LOOPBACK);
    expect(a.url.startsWith("https://portal.test/authorize?")).toBe(true);
    expect(a.state).not.toBe(b.state);
    expect(fromEntryURL(a.url).challenge).not.toBe(fromEntryURL(b.url).challenge);
    expect(fromEntryURL(a.url).jkt).not.toBe(fromEntryURL(b.url).jkt);
  });
});

// ------------------------------------------------------- channel_for_redirect

describe("channel_for_redirect", () => {
  it.each(vectors.channel_for_redirect.map((c) => [c.redirect_uri, c.channel] as const))("%s → %s", async (uri, ch) => {
    expect(channelForRedirect(uri)).toBe(ch);
    // The public transaction records the same, with no way to pass another.
    const p = await start(uri, { mode: "known", issuer: BOX });
    expect(p.channel).toBe(ch);
  });
});

// ------------------------------------------------------------ callback_cases

const ENTRY_CHANNEL: Partial<Record<CallbackStep["entry"], Channel>> = {
  auth_tab_result: "auth_tab",
  android_intent: "custom_tab",
  as_web_auth: "as_web_auth",
};

/** The Android/iOS entry points, emulated over the internal validate(). */
function nativeEntry(t: Txn, step: CallbackStep, nowMs: number): Result {
  const input = step.input as string;
  const delivered = ENTRY_CHANNEL[step.entry]!;
  if (!redirectMatches(t.redirectUri, input)) {
    // A single-delivery mechanism (Auth Tab result, ASWebAuth completion)
    // cannot wait for another URL; an intent filter can.
    return { outcome: step.entry === "android_intent" ? "ignored" : "rejected", reason: "not_our_redirect" };
  }
  const r = validate(t, rawQueryOf(input), delivered, nowMs);
  return step.entry === "as_web_auth" && r.outcome === "ignored" ? { outcome: "rejected", reason: r.reason } : r;
}

function acceptResult(r: Result | undefined): Result {
  if (r?.outcome !== "issuer_changed") return { outcome: "rejected", reason: "not_an_issuer_change" };
  return { outcome: "authorized", code: r.code, issuer: r.issuer, match: "confirmed" };
}

function txnFor(c: CallbackCase): Txn {
  const e = c.pending.expectation;
  return {
    state: c.pending.state,
    expectation: e.mode === "discover" ? { mode: "discover", issuer: "" } : { mode: e.mode, issuer: e.issuer! },
    channel: c.pending.channel,
    redirectUri: c.pending.redirect_uri,
    policy: { boxDomain: c.pending.policy.box_domain, requireVerifiedChannel: c.pending.policy.require_verified_channel },
    createdAtMs: NOW_MS,
    consumed: false,
  };
}

/** Substitute the transaction's real (random) state for the vectors' "s". */
function withState(input: CallbackStep["input"], state: string): CallbackStep["input"] {
  if (typeof input === "string") return input.replace(/([?&])state=s(?=&|#|$)/, `$1state=${state}`);
  if (input && input.state === "s") return { ...input, state };
  return input;
}

const usesJsEntries = (c: CallbackCase): boolean => c.steps.some((s) => s.entry === "js_url" || s.entry === "js_params");

describe("callback_cases", () => {
  it("has the 29 cases of v3", () => expect(vectors.callback_cases).toHaveLength(29));

  // Pass 1: each case through the entry points. JS entries run the PUBLIC
  // API on a transaction startAuthorization made; the Android/iOS entries
  // run through the internal validate() with their channel.
  it.each(vectors.callback_cases.map((c) => [c.name, c] as const))("entry points: %s", async (_n, c) => {
    if (usesJsEntries(c)) {
      const e = c.pending.expectation;
      const p = await start(c.pending.redirect_uri, e.mode === "discover" ? { mode: "discover" } : { mode: e.mode, issuer: e.issuer! }, {
        boxDomain: c.pending.policy.box_domain,
        requireVerifiedChannel: c.pending.policy.require_verified_channel,
        allowDev: true,
      });
      expect(p.channel).toBe(c.pending.channel);
      let last: AuthorizationOutcome | undefined;
      for (const s of c.steps) {
        vi.setSystemTime(NOW_MS + (s.age_s ?? 0) * 1000);
        const input = withState(s.input, p.state);
        let o: AuthorizationOutcome;
        if (s.entry === "js_url") {
          o = validateCallback(p, input as string);
        } else if (s.entry === "js_params") {
          o = validateCallbackParams(p, input as Record<string, string>);
        } else {
          o = acceptIssuerChange(last!);
        }
        expect(shapeOf(o), `${s.entry} ${JSON.stringify(s.input)}`).toEqual(s.expect);
        last = o;
      }
      return;
    }
    const t = txnFor(c);
    let last: Result | undefined;
    for (const s of c.steps) {
      if (s.delivered && s.delivered !== "none") expect(ENTRY_CHANNEL[s.entry]).toBe(s.delivered);
      const r = s.entry === "accept_issuer_change" ? acceptResult(last) : nativeEntry(t, s, NOW_MS + (s.age_s ?? 0) * 1000);
      expect(shapeOfResult(r), s.entry).toEqual(s.expect);
      last = r;
    }
  });

  // Pass 2 (as the reference runs it): every case through the bare
  // validate() with the step's `delivered` channel; "none" is the entry
  // point's own redirect pre-check. For js_url, the channel the SDK derives
  // from the callback URL must equal `delivered`.
  it.each(vectors.callback_cases.map((c) => [c.name, c] as const))("internal validate: %s", (_n, c) => {
    const t = txnFor(c);
    let last: Result | undefined;
    for (const s of c.steps) {
      let r: Result;
      if (s.entry === "accept_issuer_change") {
        r = acceptResult(last);
      } else if (s.delivered === "none") {
        expect(redirectMatches(t.redirectUri, s.input as string)).toBe(false);
        r = { outcome: "ignored", reason: "not_our_redirect" };
      } else {
        if (s.entry === "js_url") expect(channelForCallbackURL(t, s.input as string)).toBe(s.delivered);
        const q =
          typeof s.input === "string"
            ? rawQueryOf(s.input)
            : Object.entries(s.input!).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
        r = validate(t, q, s.delivered as Channel, NOW_MS + (s.age_s ?? 0) * 1000);
        if (s.entry === "as_web_auth" && r.outcome === "ignored") r = { outcome: "rejected", reason: r.reason };
      }
      expect(shapeOfResult(r), s.entry).toEqual(s.expect);
      last = r;
    }
  });
});

// ------------------------------------------------- JS entry-point properties

describe("the channel cannot be chosen by the integrator (sim §8, JS entries)", () => {
  it("no public entry yields a verified result it did not earn", async () => {
    let checked = 0;
    for (const redirect of [LOOPBACK, CUSTOM]) {
      for (const exp of [{ mode: "discover" }, { mode: "known", issuer: BOX }] as const) {
        const mk = (): Promise<PendingAuthorization | null> => start(redirect, exp).catch(() => null);
        const entries: Record<string, (p: PendingAuthorization) => AuthorizationOutcome> = {
          "js params": (p) => validateCallbackParams(p, { code: "c", iss: OTHER, state: p.state }),
          "js url (custom scheme)": (p) => validateCallback(p, `${CUSTOM}?code=c&iss=${encodeURIComponent(OTHER)}&state=${p.state}`),
          "js url (other loopback)": (p) => validateCallback(p, `http://127.0.0.1:1/callback?code=c&iss=${encodeURIComponent(OTHER)}&state=${p.state}`),
          "js url (same loopback)": (p) => validateCallback(p, `${LOOPBACK}?code=c&iss=${encodeURIComponent(OTHER)}&state=${p.state}`),
        };
        for (const [name, run] of Object.entries(entries)) {
          const p = await mk();
          if (!p) {
            // Discover on a custom scheme is refused at start under the default policy.
            expect(redirect === CUSTOM && exp.mode === "discover").toBe(true);
            continue;
          }
          const o = run(p);
          const earned = name === "js url (same loopback)" && redirect === LOOPBACK;
          if (!earned) {
            expect(o.kind === "issuer_changed" || (o.kind === "authorized" && o.match === "discovered"), `${redirect} ${exp.mode} ${name}`).toBe(false);
            if (redirect === LOOPBACK) expect(o.kind, `${exp.mode} ${name}`).not.toBe("authorized");
          }
          checked++;
        }
      }
    }
    expect(checked).toBe(12);
  });

  it("gives exactly these outcomes for another box's iss on each entry", async () => {
    const ignored: AuthorizationOutcome = { kind: "ignored", reason: "not_our_redirect" };
    const table: [string, IssuerExpectation, Record<string, AuthorizationOutcome>][] = [
      [LOOPBACK, { mode: "discover" }, {
        params: { kind: "rejected", reason: "channel_mismatch" },
        custom: ignored, otherLoopback: ignored,
        sameLoopback: { kind: "authorized", issuer: OTHER, match: "discovered" },
      }],
      [LOOPBACK, { mode: "known", issuer: BOX }, {
        params: { kind: "rejected", reason: "channel_mismatch" },
        custom: ignored, otherLoopback: ignored,
        sameLoopback: { kind: "issuer_changed", issuer: OTHER, expected: BOX },
      }],
      [CUSTOM, { mode: "known", issuer: BOX }, {
        params: { kind: "rejected", reason: "issuer_mismatch" },
        custom: { kind: "rejected", reason: "issuer_mismatch" },
        otherLoopback: ignored, sameLoopback: ignored,
      }],
    ];
    for (const [redirect, exp, want] of table) {
      for (const [entry, expected] of Object.entries(want)) {
        const p = await start(redirect, exp);
        const q = `code=c&iss=${encodeURIComponent(OTHER)}&state=${p.state}`;
        const o =
          entry === "params" ? validateCallbackParams(p, { code: "c", iss: OTHER, state: p.state })
          : entry === "custom" ? validateCallback(p, `${CUSTOM}?${q}`)
          : entry === "otherLoopback" ? validateCallback(p, `http://127.0.0.1:1/callback?${q}`)
          : validateCallback(p, `${LOOPBACK}?${q}`);
        expect(o, `${redirect} ${exp.mode} ${entry}`).toEqual(expected);
      }
    }
  });

  it("a deep-link transaction validated from its URL is external: Known exact passes, nothing more", async () => {
    const p = await start(CUSTOM, { mode: "known", issuer: BOX });
    expect(validateCallback(p, `${CUSTOM}?code=c&iss=${encodeURIComponent(BOX)}&state=${p.state}`)).toEqual({
      kind: "authorized",
      issuer: BOX,
      match: "exact",
    });
  });

  it("a hand-made pending is refused, and a tampered copy of a real one too", async () => {
    const fake = { url: "x", state: "s", channel: "loopback" } as PendingAuthorization;
    expect(() => validateCallback(fake, LOOPBACK + "?state=s&code=c&iss=" + BOX)).toThrow(PlumOAuthError);
    const real = await start(CUSTOM, { mode: "known", issuer: BOX });
    expect(Object.isFrozen(real)).toBe(true);
    const copy = { ...real, channel: "loopback" as const };
    expect(() => validateCallbackParams(copy, { state: real.state, code: "c", iss: OTHER })).toThrow(/invalid_pending|PendingAuthorization/);
  });
});

describe("outcomes", () => {
  it("a stray callback is ignored and the real one still completes", async () => {
    const p = await start(LOOPBACK);
    const q = `code=c&iss=${encodeURIComponent(BOX)}`;
    expect(validateCallback(p, `${LOOPBACK}?${q}&state=WRONG`)).toEqual({ kind: "ignored", reason: "state_mismatch" });
    expect(validateCallback(p, `http://127.0.0.1:53682/other?${q}&state=${p.state}`)).toEqual({ kind: "ignored", reason: "not_our_redirect" });
    expect(validateCallback(p, `not a url`)).toEqual({ kind: "ignored", reason: "not_our_redirect" });
    expect(validateCallback(p, `${LOOPBACK}?${q}&state=${p.state}`)).toEqual({ kind: "authorized", issuer: BOX, match: "discovered" });
    // One callback per transaction.
    expect(validateCallback(p, `${LOOPBACK}?${q}&state=${p.state}`)).toEqual({ kind: "ignored", reason: "state_mismatch" });
  });

  it("carries error_description on a denial", async () => {
    const p = await start(LOOPBACK);
    expect(validateCallback(p, `${LOOPBACK}?error=access_denied&error_description=no%20thanks&state=${p.state}`)).toEqual({
      kind: "denied",
      error: "access_denied",
      description: "no thanks",
    });
  });

  it("accepts Obsidian's protocol-handler record, extra keys included", async () => {
    const p = await start("obsidian://plum-sync", { mode: "known", issuer: BOX });
    const o = validateCallbackParams(p, { action: "plum-sync", code: "c", iss: BOX, state: p.state });
    expect(o).toEqual({ kind: "authorized", issuer: BOX, match: "exact" });
  });

  it("are frozen; a hand-made or copied authorized outcome is refused", async () => {
    const p = await start(LOOPBACK);
    const o = validateCallback(p, `${LOOPBACK}?code=c&iss=${encodeURIComponent(BOX)}&state=${p.state}`);
    expect(Object.isFrozen(o)).toBe(true);
    const forged = { kind: "authorized", issuer: "https://pb-evil.plumbox.me", match: "exact" } as const;
    await expect(completeAuthorization(forged)).rejects.toMatchObject({ code: "invalid_outcome" });
    await expect(completeAuthorization({ ...o })).rejects.toMatchObject({ code: "invalid_outcome" });
    expect(acceptIssuerChange({ kind: "issuer_changed", issuer: OTHER, expected: BOX })).toEqual({
      kind: "rejected",
      reason: "not_an_issuer_change",
    });
  });

  it("an issuer change is not authorized until the user accepts it", async () => {
    const p = await start(LOOPBACK, { mode: "known", issuer: BOX });
    const changed = validateCallback(p, `${LOOPBACK}?code=c&iss=${encodeURIComponent(OTHER)}&state=${p.state}`);
    expect(changed).toEqual({ kind: "issuer_changed", issuer: OTHER, expected: BOX });
    await expect(completeAuthorization(changed)).rejects.toMatchObject({ code: "invalid_outcome" });
    expect(acceptIssuerChange(changed)).toEqual({ kind: "authorized", issuer: OTHER, match: "confirmed" });
  });

  it("expires after 30 minutes and destroys the key", async () => {
    const p = await start(LOOPBACK, { mode: "discover" }, {}, true);
    vi.setSystemTime(NOW_MS + 30 * 60 * 1000 + 1);
    expect(validateCallback(p, `${LOOPBACK}?code=c&iss=${encodeURIComponent(BOX)}&state=${p.state}`)).toEqual({
      kind: "rejected",
      reason: "expired",
    });
    await expect(serializePendingAuthorization(p)).rejects.toMatchObject({ code: "key_lost" });
  });

  it("is still valid at exactly 30 minutes", async () => {
    const p = await start(LOOPBACK);
    vi.setSystemTime(NOW_MS + 30 * 60 * 1000);
    expect(validateCallback(p, `${LOOPBACK}?code=c&iss=${encodeURIComponent(BOX)}&state=${p.state}`).kind).toBe("authorized");
  });

  it("discard ends the transaction", async () => {
    const p = await start(LOOPBACK, { mode: "discover" }, {}, true);
    discardPendingAuthorization(p);
    expect(validateCallback(p, `${LOOPBACK}?code=c&iss=${encodeURIComponent(BOX)}&state=${p.state}`).kind).toBe("ignored");
    await expect(serializePendingAuthorization(p)).rejects.toMatchObject({ code: "key_lost" });
    discardPendingAuthorization({ url: "", state: "", channel: "external" }); // unknown: a no-op
  });
});

// -------------------------------------------------------------- serialization

describe("serialization", () => {
  it("refuses a transaction that was not started persistable", async () => {
    const p = await start("obsidian://plum-sync", { mode: "known", issuer: BOX });
    await expect(serializePendingAuthorization(p)).rejects.toMatchObject({ code: "not_persistable" });
  });

  it("round-trips: serialize → deserialize → validate → complete", async () => {
    const p = await start("obsidian://plum-sync", { mode: "known", issuer: BOX }, {}, true);
    const s = await serializePendingAuthorization(p);
    const j = JSON.parse(s) as Record<string, unknown>;
    expect(j.v).toBe(1);
    expect(j.expectation).toEqual({ mode: "known", issuer: BOX });
    expect(j.channel).toBe("external");
    expect(j.policy).toEqual({ boxDomain: "plumbox.me", requireVerifiedChannel: true, allowDev: false });

    const q = await deserializePendingAuthorization(s); // e.g. in the plugin instance the deep link woke
    expect({ url: q.url, state: q.state, channel: q.channel }).toEqual({ url: p.url, state: p.state, channel: p.channel });
    expect(await serializePendingAuthorization(q)).toBe(s);

    const o = validateCallbackParams(q, { code: "CODE1", iss: BOX, state: q.state });
    expect(o).toEqual({ kind: "authorized", issuer: BOX, match: "exact" });
    const bound = fromEntryURL(q.url);
    const box = fakeBox({ issuer: BOX, code: "CODE1", ...bound });
    const g = await completeAuthorization(o, { http: box.adapter });
    expect(g).toEqual({ accessToken: "plum_pat_test", tokenType: "bearer", scope: "files:read", issuer: BOX });
    expect(box.requests).toHaveLength(1);
  });

  it("reads the legacy {verifier, state} record and any edited record as invalid", async () => {
    const p = await start("obsidian://plum-sync", { mode: "known", issuer: BOX }, {}, true);
    const good = JSON.parse(await serializePendingAuthorization(p)) as Record<string, unknown>;
    const other = JSON.parse(
      await serializePendingAuthorization(await start("obsidian://plum-sync", { mode: "known", issuer: BOX }, {}, true)),
    ) as Record<string, unknown>;
    const bad: [string, string][] = [
      ["legacy record", JSON.stringify({ verifier: "v", state: "s" })],
      ["garbage", "{"],
      ["v2", JSON.stringify({ ...good, v: 2 })],
      ["channel edited", JSON.stringify({ ...good, channel: "loopback" })],
      ["key swapped", JSON.stringify({ ...good, key: other.key })],
      ["discover on a deep link", JSON.stringify({ ...good, expectation: { mode: "discover" } })],
      ["dev without allowDev", JSON.stringify({ ...good, expectation: { mode: "dev", issuer: "http://10.0.2.2:8080" } })],
      ["alias issuer", JSON.stringify({ ...good, expectation: { mode: "known", issuer: "https://pb-1234-lan.plumbox.me" } })],
      ["no scopes", JSON.stringify({ ...good, scopes: [] })],
      ["no policy", JSON.stringify({ ...good, policy: undefined })],
    ];
    for (const [name, s] of bad) {
      await expect(deserializePendingAuthorization(s), name).rejects.toMatchObject({ code: "invalid_pending" });
    }
    // The opt-out is part of the record, so a deep-link Discover that was
    // started with it restores.
    const optOut = JSON.stringify({
      ...good,
      expectation: { mode: "discover" },
      policy: { boxDomain: "plumbox.me", requireVerifiedChannel: false, allowDev: false },
    });
    await expect(deserializePendingAuthorization(optOut)).resolves.toBeTruthy();
  });
});
