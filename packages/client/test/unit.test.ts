import { describe, expect, it, vi } from "vitest";
import { fetchAdapter } from "../src/adapters/fetch.js";
import { PlumClient } from "../src/client.js";
import { ListingIncompleteError, parseRetryAfter, PlumApiError, PlumAuthError } from "../src/errors.js";
import type { HttpAdapter, HttpRequest, HttpResponse } from "../src/http.js";
import { buildMultipart, parseSessionCookie } from "../src/http.js";

function textResponse(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body: new TextEncoder().encode(body).buffer as ArrayBuffer };
}

function mockAdapter(handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>): {
  adapter: HttpAdapter;
  requests: HttpRequest[];
} {
  const requests: HttpRequest[] = [];
  return {
    requests,
    adapter: {
      async request(req) {
        requests.push(req);
        return handler(req);
      },
    },
  };
}

describe("parseSessionCookie", () => {
  it("extracts the session cookie", () => {
    expect(
      parseSessionCookie("session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax"),
    ).toBe("session=abc123");
  });
  it("finds session among multiple cookies", () => {
    expect(parseSessionCookie("other=x; Path=/, session=tok9; HttpOnly")).toBe("session=tok9");
  });
  it("returns null when absent", () => {
    expect(parseSessionCookie(undefined)).toBeNull();
    expect(parseSessionCookie("other=x")).toBeNull();
  });
});

describe("login", () => {
  it("captures the session cookie and uses it on later requests", async () => {
    const { adapter, requests } = mockAdapter((req) => {
      if (req.url.endsWith("/api/auth/login")) {
        return textResponse(200, `{"success":true}`, {
          "set-cookie": "session=s3cr3t; Path=/; HttpOnly",
        });
      }
      return textResponse(200, `{"user":{"id":"u1","username":"ceo"}}`);
    });
    const client = new PlumClient({ baseUrl: "https://pb-x.plumbox.me", http: adapter });
    const result = await client.login({ login: "a@b.c", password: "pw" });
    expect(result.ok).toBe(true);
    const me = await client.auth.me();
    expect(me.id).toBe("u1"); // unwraps the box's {"user":{...}} envelope
    expect(requests[1]?.headers?.["cookie"]).toBe("session=s3cr3t");
  });

  it("returns a TOTP continuation when required", async () => {
    const { adapter, requests } = mockAdapter((req) => {
      if (req.url.endsWith("/api/auth/login")) {
        return textResponse(200, `{"success":true,"requireTotp":true,"tempToken":"tmp1"}`);
      }
      if (req.url.endsWith("/api/auth/totp/verify")) {
        return textResponse(200, `{"success":true}`, { "set-cookie": "session=after2fa" });
      }
      return textResponse(404, "nope");
    });
    const client = new PlumClient({ baseUrl: "https://pb-x.plumbox.me", http: adapter });
    const result = await client.login({ login: "a@b.c", password: "pw" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      await result.verifyTotp("123456");
      expect(JSON.parse(requests[1]!.body as string)).toEqual({ tempToken: "tmp1", code: "123456" });
      expect(client.hasSession).toBe(true);
    }
  });

  it("fails loudly when the adapter cannot expose Set-Cookie", async () => {
    const { adapter } = mockAdapter(() => textResponse(200, `{"success":true}`));
    const client = new PlumClient({ baseUrl: "https://pb-x.plumbox.me", http: adapter });
    await expect(client.login({ login: "a", password: "b" })).rejects.toThrow(/Set-Cookie/);
  });
});

describe("bearer auth + errors", () => {
  it("sends the PAT as a Bearer header", async () => {
    const { adapter, requests } = mockAdapter(() => textResponse(200, "[]"));
    const client = new PlumClient({
      baseUrl: "https://pb-x.plumbox.me",
      token: "plum_pat_abc",
      http: adapter,
    });
    await client.auth.listTokens();
    expect(requests[0]?.headers?.["authorization"]).toBe("Bearer plum_pat_abc");
  });

  it("maps 401 to PlumAuthError and fires onAuthError", async () => {
    const { adapter } = mockAdapter(() => textResponse(401, "Unauthorized"));
    const onAuthError = vi.fn();
    const client = new PlumClient({
      baseUrl: "https://pb-x.plumbox.me",
      token: "plum_pat_dead",
      http: adapter,
      onAuthError,
    });
    await expect(client.auth.me()).rejects.toBeInstanceOf(PlumAuthError);
    expect(onAuthError).toHaveBeenCalledOnce();
  });

  it("parses structured error bodies", async () => {
    const { adapter } = mockAdapter(() =>
      textResponse(409, `{"error":"version_mismatch","message":"nope"}`),
    );
    const client = new PlumClient({ baseUrl: "https://x", token: "t", http: adapter });
    // .then(throw, cast) rather than .catch(cast): .catch widens the promise to
    // "the resolved value or the error", and a call that unexpectedly succeeds
    // should say so instead of failing on a missing property.
    const err = await client.auth.me().then(
      (): never => { throw new Error("auth.me() resolved; it was supposed to reject"); },
      (e: unknown) => e as PlumApiError,
    );
    expect(err).toBeInstanceOf(PlumApiError);
    expect(err.code).toBe("version_mismatch");
    expect(err.message).toBe("nope");
  });
});

describe("drive", () => {
  it("listAll walks pages", async () => {
    const pageOf = (offset: number) => {
      const items = Array.from({ length: offset < 1000 ? 1000 : 500 }, (_, i) => ({
        name: `f${offset + i}`,
        path: `/f${offset + i}`,
        isDir: false,
        size: 1,
        modTime: "2026-01-01T00:00:00Z",
      }));
      return JSON.stringify({ items, total: 1500, limit: 1000, offset });
    };
    const { adapter } = mockAdapter((req) => {
      const url = new URL(req.url);
      return textResponse(200, pageOf(Number(url.searchParams.get("offset"))));
    });
    const client = new PlumClient({ baseUrl: "https://x", token: "t", http: adapter });
    let count = 0;
    for await (const _ of client.drive.listAll("/", { recursive: true, hash: true })) count++;
    expect(count).toBe(1500);
  });

  it("list sends recursive/hash params", async () => {
    const { adapter, requests } = mockAdapter(() =>
      textResponse(200, `{"items":[],"total":0,"limit":1000,"offset":0}`),
    );
    const client = new PlumClient({ baseUrl: "https://x", token: "t", http: adapter });
    await client.drive.list("/Obsidian/vault", { recursive: true, hash: true });
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get("recursive")).toBe("1");
    expect(url.searchParams.get("hash")).toBe("1");
    expect(url.searchParams.get("path")).toBe("/Obsidian/vault");
  });

  it("upload builds multipart with overwrite field", async () => {
    const { adapter, requests } = mockAdapter(() =>
      textResponse(200, `{"status":"ok","path":"/v/a.md","name":"a.md"}`),
    );
    const client = new PlumClient({ baseUrl: "https://x", token: "t", http: adapter });
    const entry = await client.drive.upload("/v/a.md", "hello", { overwrite: true });
    expect(entry.path).toBe("/v/a.md");
    const req = requests[0]!;
    expect(req.headers?.["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const bodyText = new TextDecoder().decode(req.body as ArrayBuffer);
    expect(bodyText).toContain(`name="overwrite"`);
    expect(bodyText).toContain(`name="path"`);
    expect(bodyText).toContain(`filename="a.md"`);
    expect(bodyText).toContain("hello");
  });

  it("large uploads use the chunked protocol with Content-Range", async () => {
    const { adapter, requests } = mockAdapter((req) => {
      if (req.url.endsWith("/api/uploads/init")) {
        return textResponse(200, `{"uploadId":"u1","chunkSize":4194304}`);
      }
      const range = req.headers?.["content-range"] ?? "";
      if (range.startsWith(`bytes 8388608-`)) {
        return textResponse(200, `{"path":"/big.bin","name":"big.bin"}`);
      }
      return textResponse(200, `{"receivedBytes":0,"totalBytes":0,"status":"active"}`);
    });
    const client = new PlumClient({ baseUrl: "https://x", token: "t", http: adapter });
    const big = new Uint8Array(9 * 1024 * 1024);
    const entry = await client.drive.upload("/big.bin", big);
    expect(entry.path).toBe("/big.bin");
    // init + 3 chunks of 4MiB/4MiB/1MiB
    expect(requests).toHaveLength(4);
    expect(requests[1]?.headers?.["content-range"]).toBe(`bytes 0-4194303/${big.byteLength}`);
  });

  it("mkdir splits parent and name; move/rename/remove hit the right routes", async () => {
    const { adapter, requests } = mockAdapter(() => textResponse(200, `{"status":"ok"}`));
    const client = new PlumClient({ baseUrl: "https://x", token: "t", http: adapter });
    await client.drive.mkdir("/a/b/c");
    expect(JSON.parse(requests[0]!.body as string)).toEqual({ path: "/a/b", name: "c" });
    await client.drive.rename("/a/b/c", "d");
    expect(JSON.parse(requests[1]!.body as string)).toEqual({ path: "/a/b/c", name: "d" });
    await client.drive.move("/a/b/d", "/x/d");
    expect(JSON.parse(requests[2]!.body as string)).toEqual({ path: "/a/b/d", newPath: "/x/d" });
    await client.drive.remove("/x/d");
    expect(requests[3]!.method).toBe("DELETE");
    expect(new URL(requests[3]!.url).searchParams.get("path")).toBe("/x/d");
  });
});

// What plum-box-core answers when a recursive listing could not read every
// folder (internal/drive/list.go): 503 + this body, never a shorter 200.
const INCOMPLETE_BODY = JSON.stringify({
  error: "listing_incomplete",
  message: "Some folders could not be read, so the listing would be incomplete",
});

function entriesPage(offset: number, n: number, total: number, extra: Record<string, unknown> = {}): string {
  const items = Array.from({ length: n }, (_, i) => ({
    name: `f${offset + i}`,
    path: `/f${offset + i}`,
    isDir: false,
    size: 1,
    modTime: "2026-01-01T00:00:00Z",
    ...extra,
  }));
  return JSON.stringify({ items, total, limit: 1000, offset });
}

/** Rejection value of p, failing the test if p resolves. */
async function rejection<T = unknown>(p: Promise<unknown>): Promise<T> {
  return p.then(
    (): never => { throw new Error("resolved; it was supposed to reject"); },
    (e: unknown) => e as T,
  );
}

describe("drive: incomplete listings", () => {
  it("a 503 listing_incomplete is a ListingIncompleteError, not an empty page", async () => {
    const { adapter } = mockAdapter(() => textResponse(503, INCOMPLETE_BODY, { "content-type": "application/json" }));
    const client = new PlumClient({ baseUrl: "https://x", token: "t", http: adapter });
    const err = await rejection<ListingIncompleteError>(client.drive.list("/", { recursive: true }));
    expect(err).toBeInstanceOf(ListingIncompleteError);
    expect(err).toBeInstanceOf(PlumApiError); // existing `catch (e instanceof PlumApiError)` still sees it
    expect(err.name).toBe("ListingIncompleteError");
    expect(err.status).toBe(503);
    expect(err.code).toBe("listing_incomplete");
    expect(err.message).toMatch(/could not be read/);
    expect(err.retryAfterMs).toBeUndefined(); // core sends no Retry-After today
  });

  it("listAll throws on the first page instead of yielding nothing", async () => {
    const { adapter } = mockAdapter(() => textResponse(503, INCOMPLETE_BODY));
    const client = new PlumClient({ baseUrl: "https://x", token: "t", http: adapter });
    const seen: string[] = [];
    const err = await rejection((async () => {
      for await (const e of client.drive.listAll("/", { recursive: true })) seen.push(e.path);
    })());
    expect(err).toBeInstanceOf(ListingIncompleteError);
    expect(seen).toEqual([]);
  });

  it("listAll throws when a later page is incomplete rather than ending early", async () => {
    const { adapter, requests } = mockAdapter((req) => {
      const offset = Number(new URL(req.url).searchParams.get("offset"));
      return offset === 0 ? textResponse(200, entriesPage(0, 1000, 1500)) : textResponse(503, INCOMPLETE_BODY, { "retry-after": "30" });
    });
    const client = new PlumClient({ baseUrl: "https://x", token: "t", http: adapter });
    let count = 0;
    const err = await rejection<ListingIncompleteError>((async () => {
      for await (const _ of client.drive.listAll("/", { recursive: true })) count++;
    })());
    expect(err).toBeInstanceOf(ListingIncompleteError);
    expect(err.retryAfterMs).toBe(30_000);
    expect(count).toBe(1000); // what it yielded before the throw — the caller must discard it
    expect(requests).toHaveLength(2); // and nothing was retried behind the caller's back
  });

  it("other non-2xx answers throw a PlumApiError with Retry-After, never an empty list", async () => {
    for (const [status, body, headers] of [
      [500, "readdir failed", {}],
      [502, "", {}],
      [503, `{"error":"box_offline","message":"the box is not reachable"}`, { "retry-after": "5" }],
      [429, `{"error":"rate_limited"}`, { "retry-after": "Fri, 02 Oct 2026 12:00:10 GMT" }],
    ] as Array<[number, string, Record<string, string>]>) {
      const { adapter } = mockAdapter(() => textResponse(status, body, headers));
      const client = new PlumClient({ baseUrl: "https://x", token: "t", http: adapter });
      const err = await rejection<PlumApiError>((async () => {
        for await (const _ of client.drive.listAll("/", { recursive: true })) { /* nothing */ }
      })());
      expect(err).toBeInstanceOf(PlumApiError);
      expect(err).not.toBeInstanceOf(ListingIncompleteError);
      expect(err.status).toBe(status);
      if (headers["retry-after"] === "5") expect(err.retryAfterMs).toBe(5000);
      if (status === 429) expect(err.retryAfterMs).toBeTypeOf("number");
    }
  });

  it("parseRetryAfter reads delta-seconds and HTTP-dates", () => {
    const now = Date.parse("Fri, 02 Oct 2026 12:00:00 GMT");
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter(" 120 ", now)).toBe(120_000);
    expect(parseRetryAfter("Fri, 02 Oct 2026 12:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("Fri, 02 Oct 2026 11:00:00 GMT", now)).toBe(0); // in the past
    for (const bad of ["", "soon", "-1", "1.5"]) expect(parseRetryAfter(bad, now), bad).toBeUndefined();
  });

  it("over real HTTP (fetchAdapter): 503 + Retry-After reaches the caller", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "12" });
      res.end(INCOMPLETE_BODY);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as { port: number };
      const client = new PlumClient({ baseUrl: `http://127.0.0.1:${port}`, token: "t", http: fetchAdapter });
      const err = await rejection<ListingIncompleteError>((async () => {
        for await (const _ of client.drive.listAll("/", { recursive: true })) { /* nothing */ }
      })());
      expect(err).toBeInstanceOf(ListingIncompleteError);
      expect(err.retryAfterMs).toBe(12_000);
    } finally {
      server.close();
    }
  });
});

describe("buildMultipart", () => {
  it("produces a parseable body ending with the closing boundary", () => {
    const { body, contentType } = buildMultipart(
      { path: "/dir" },
      { field: "file", name: "한글 노트.md", data: new TextEncoder().encode("x") },
    );
    const boundary = contentType.split("boundary=")[1]!;
    const text = new TextDecoder().decode(body);
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
    expect(text).toContain("한글 노트.md");
  });
});
