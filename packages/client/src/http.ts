/**
 * Transport abstraction. The SDK never talks to the network directly — it
 * builds {@link HttpRequest}s and hands them to an {@link HttpAdapter}. This
 * keeps the core runtime-agnostic: Node/browser use {@link fetchAdapter},
 * Obsidian plugins inject `requestUrl` via `injectedAdapter` (which bypasses
 * CORS on both desktop and mobile).
 */
export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | Uint8Array;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. `set-cookie` must be preserved when available. */
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export interface HttpAdapter {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export function responseText(res: HttpResponse): string {
  return new TextDecoder().decode(res.body);
}

export function responseJSON<T = unknown>(res: HttpResponse): T {
  return JSON.parse(responseText(res)) as T;
}

/** Extract the `session` cookie value from a Set-Cookie header line. */
export function parseSessionCookie(setCookie: string | undefined): string | null {
  if (!setCookie) return null;
  const m = /(?:^|[,;\s])session=([^;,\s]+)/.exec(setCookie);
  return m ? `session=${m[1]}` : null;
}

export function joinURL(base: string, path: string): string {
  return base.replace(/\/+$/, "") + (path.startsWith("/") ? path : "/" + path);
}

export function toArrayBuffer(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (typeof data === "string") {
    const bytes = new TextEncoder().encode(data);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  if (data instanceof Uint8Array) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return data;
}

/**
 * Build a multipart/form-data body without relying on FormData/Blob, which
 * not every embedding runtime provides. Returns the raw body plus the
 * boundary-bearing content type.
 */
export function buildMultipart(
  fields: Record<string, string>,
  file: { field: string; name: string; data: ArrayBuffer | Uint8Array; contentType?: string },
): { body: ArrayBuffer; contentType: string } {
  const boundary = "----plumbox" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];

  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      ),
    );
  }
  // RFC 2388 filename: keep it UTF-8; the Go server reads it verbatim.
  const escapedName = file.name.replace(/"/g, '%22');
  parts.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${escapedName}"\r\n` +
        `Content-Type: ${file.contentType ?? "application/octet-stream"}\r\n\r\n`,
    ),
  );
  parts.push(file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data));
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    body.set(p, off);
    off += p.byteLength;
  }
  return {
    body: body.buffer as ArrayBuffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
