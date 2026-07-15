import type { HttpAdapter, HttpRequest, HttpResponse } from "../http.js";

/**
 * Default adapter for runtimes with a global `fetch` (Node 18+, browsers,
 * Electron). Note: in browsers, cross-origin calls to a box are blocked by
 * CORS (the box API sends no CORS headers) and `Set-Cookie` is unreadable —
 * use this adapter from Node/desktop apps, and `injectedAdapter` inside
 * Obsidian.
 */
export const fetchAdapter: HttpAdapter = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body as BodyInit | undefined,
      redirect: "follow",
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    // Node's undici hides set-cookie from forEach in some versions; recover it.
    const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    if (!headers["set-cookie"] && typeof getSetCookie === "function") {
      const cookies = getSetCookie.call(res.headers);
      if (cookies.length > 0) headers["set-cookie"] = cookies.join(", ");
    }
    return { status: res.status, headers, body: await res.arrayBuffer() };
  },
};
