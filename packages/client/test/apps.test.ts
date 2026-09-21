import { describe, expect, it } from "vitest";
import { PlumClient } from "../src/client.js";
import { PlumApiError } from "../src/errors.js";
import type { HttpAdapter, HttpRequest } from "../src/http.js";

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
  };
}

function fakeBox(routes: Record<string, { status: number; body: unknown }>) {
  const seen: HttpRequest[] = [];
  const http: HttpAdapter = {
    async request(req) {
      seen.push(req);
      const key = `${req.method ?? "GET"} ${new URL(req.url).pathname}`;
      const r = routes[key];
      if (!r) return jsonResponse(404, { error: "not_found" });
      return jsonResponse(r.status, r.body);
    },
  };
  return { http, seen };
}

describe("client.apps", () => {
  it("ensureServiceInstalled reports an installed service", async () => {
    const box = fakeBox({ "GET /api/apps/com.example.notes/status": { status: 200, body: { state: "running" } } });
    const client = new PlumClient({ baseUrl: "https://pb-x.plumbox.me", token: "plum_pat_t", http: box.http });
    const r = await client.apps.ensureServiceInstalled("com.example.notes");
    expect(r.installed).toBe(true);
    if (r.installed) expect(r.status.state).toBe("running");
    expect(box.seen[0]?.headers?.authorization).toBe("Bearer plum_pat_t");
  });

  it("ensureServiceInstalled hands back install links on 404", async () => {
    const box = fakeBox({});
    const client = new PlumClient({ baseUrl: "https://pb-x.plumbox.me/", token: "t", http: box.http });
    const r = await client.apps.ensureServiceInstalled("com.example.notes");
    expect(r.installed).toBe(false);
    if (!r.installed) {
      expect(r.installUrl).toBe("plum://store/com.example.notes");
      expect(r.webUrl).toBe("https://pb-x.plumbox.me/#/store/com.example.notes?install=1");
    }
  });

  it("ensureServiceInstalled rethrows anything but 404", async () => {
    const box = fakeBox({ "GET /api/apps/com.example.notes/status": { status: 503, body: { error: "runtime_unavailable" } } });
    const client = new PlumClient({ baseUrl: "https://pb-x.plumbox.me", token: "t", http: box.http });
    await expect(client.apps.ensureServiceInstalled("com.example.notes")).rejects.toBeInstanceOf(PlumApiError);
  });

  it("entitlement returns the box's receipt view", async () => {
    const box = fakeBox({
      "GET /api/apps/com.example.notes/entitlement": {
        status: 200,
        body: { skus: [{ sku: "pro", kind: "one_time", expires_at: "", active: true }], refreshed_at: "2026-09-19T12:00:00Z", stale: false },
      },
      "POST /api/apps/entitlements/refresh": { status: 200, body: { ok: true, receipts: 1 } },
    });
    const client = new PlumClient({ baseUrl: "https://pb-x.plumbox.me", token: "t", http: box.http });
    const e = await client.apps.entitlement("com.example.notes");
    expect(e.skus[0]?.sku).toBe("pro");
    expect(e.stale).toBe(false);
    expect(await client.apps.refreshEntitlements()).toBe(1);
  });
});
