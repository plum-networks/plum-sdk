import { describe, expect, it, vi } from "vitest";
import { PlumClient } from "../src/client.js";
import { PlumApiError, PlumAuthError } from "../src/errors.js";
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
