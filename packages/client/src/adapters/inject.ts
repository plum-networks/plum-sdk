import type { HttpAdapter, HttpRequest, HttpResponse } from "../http.js";

/**
 * Shape of Obsidian's `requestUrl` — declared structurally so this package
 * has no dependency on the `obsidian` module.
 */
export interface RequestUrlLike {
  (options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    contentType?: string;
    throw?: boolean;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
  }>;
}

/**
 * Adapter for Obsidian plugins:
 *
 * ```ts
 * import { requestUrl } from "obsidian";
 * const client = new PlumClient({ baseUrl, token, http: injectedAdapter(requestUrl) });
 * ```
 *
 * `requestUrl` bypasses CORS on desktop AND mobile, so the SDK works without
 * `isDesktopOnly`.
 */
export function injectedAdapter(requestUrl: RequestUrlLike): HttpAdapter {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const body =
        req.body instanceof Uint8Array
          ? (req.body.buffer.slice(
              req.body.byteOffset,
              req.body.byteOffset + req.body.byteLength,
            ) as ArrayBuffer)
          : req.body;
      const res = await requestUrl({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body,
        throw: false, // surface non-2xx as structured errors, not exceptions
      });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) {
        headers[k.toLowerCase()] = v;
      }
      return { status: res.status, headers, body: res.arrayBuffer };
    },
  };
}
