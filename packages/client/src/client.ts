import { fetchAdapter } from "./adapters/fetch.js";
import { errorFromResponse, PlumAuthError } from "./errors.js";
import type { HttpAdapter, HttpResponse } from "./http.js";
import { joinURL, parseSessionCookie, responseJSON, responseText } from "./http.js";
import { DriveApi } from "./drive.js";
import type { CreatedToken, TokenInfo, TokenScope, TokenStorage } from "./types.js";

export interface PlumClientOptions {
  /** `https://pb-<sub>.plumbox.me` — from {@link discover} or stored settings. */
  baseUrl: string;
  /** PAT (`plum_pat_…`). When set, every request uses Bearer auth. */
  token?: string;
  /** Transport. Defaults to global-fetch. Obsidian: `injectedAdapter(requestUrl)`. */
  http?: HttpAdapter;
  /** Optional persistence for the PAT (key: "plumbox.token"). */
  tokenStorage?: TokenStorage;
  /** Called once per auth failure (revoked/expired credential) — hook your re-login UI here. */
  onAuthError?: (err: PlumAuthError) => void;
}

const TOKEN_STORAGE_KEY = "plumbox.token";

export interface LoginOk {
  ok: true;
  requireTotp?: undefined;
}
export interface LoginNeedsTotp {
  ok: false;
  requireTotp: true;
  /** Complete the 2nd factor; resolves once the session is established. */
  verifyTotp(code: string): Promise<LoginOk>;
}
export type LoginResult = LoginOk | LoginNeedsTotp;

export class PlumClient {
  readonly baseUrl: string;
  readonly drive: DriveApi;
  readonly auth: AuthApi;

  private http: HttpAdapter;
  private token?: string;
  private sessionCookie: string | null = null;
  private tokenStorage?: TokenStorage;
  private onAuthError?: (err: PlumAuthError) => void;

  constructor(opts: PlumClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.http = opts.http ?? fetchAdapter;
    this.token = opts.token;
    this.tokenStorage = opts.tokenStorage;
    this.onAuthError = opts.onAuthError;
    this.drive = new DriveApi(this);
    this.auth = new AuthApi(this);
  }

  /** Load a previously stored PAT from tokenStorage. Returns true when found. */
  async loadToken(): Promise<boolean> {
    if (!this.tokenStorage) return false;
    const stored = await this.tokenStorage.get(TOKEN_STORAGE_KEY);
    if (stored) this.token = stored;
    return !!stored;
  }

  /** Adopt a PAT for all subsequent requests (and persist it when storage is configured). */
  async setToken(token: string): Promise<void> {
    this.token = token;
    await this.tokenStorage?.set(TOKEN_STORAGE_KEY, token);
  }

  async clearToken(): Promise<void> {
    this.token = undefined;
    await this.tokenStorage?.delete(TOKEN_STORAGE_KEY);
  }

  get hasToken(): boolean {
    return !!this.token;
  }

  get hasSession(): boolean {
    return !!this.sessionCookie;
  }

  /**
   * First-factor login with the box account's email/username + password.
   * On success the client holds a session cookie (7-day TTL) — immediately
   * mint a PAT with `auth.createToken` and persist only that.
   */
  async login(cred: { login: string; password: string }): Promise<LoginResult> {
    const res = await this.request("/api/auth/login", {
      method: "POST",
      json: { login: cred.login, password: cred.password },
      allowStatus: [200],
    });
    const body = responseJSON<{ requireTotp?: boolean; tempToken?: string }>(res);
    if (body.requireTotp && body.tempToken) {
      const tempToken = body.tempToken;
      return {
        ok: false,
        requireTotp: true,
        verifyTotp: async (code: string): Promise<LoginOk> => {
          const vres = await this.request("/api/auth/totp/verify", {
            method: "POST",
            json: { tempToken, code },
            allowStatus: [200],
          });
          this.captureSession(vres);
          return { ok: true };
        },
      };
    }
    this.captureSession(res);
    return { ok: true };
  }

  private captureSession(res: HttpResponse): void {
    const cookie = parseSessionCookie(res.headers["set-cookie"]);
    if (!cookie) {
      throw errorFromResponse(
        502,
        "login succeeded but no session cookie was visible to the SDK (the HTTP adapter must expose the Set-Cookie header)",
      );
    }
    this.sessionCookie = cookie;
  }

  /** Internal: perform an API request with auth + error mapping. */
  async request(
    path: string,
    opts: {
      method?: string;
      json?: unknown;
      body?: string | ArrayBuffer | Uint8Array;
      headers?: Record<string, string>;
      allowStatus?: number[];
    } = {},
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.token) {
      headers["authorization"] = `Bearer ${this.token}`;
    } else if (this.sessionCookie) {
      headers["cookie"] = this.sessionCookie;
    }
    let body = opts.body;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const res = await this.http.request({
      url: joinURL(this.baseUrl, path),
      method: opts.method ?? "GET",
      headers,
      body,
    });
    const ok = opts.allowStatus
      ? opts.allowStatus.includes(res.status)
      : res.status >= 200 && res.status < 300;
    if (!ok) {
      const err = errorFromResponse(res.status, responseText(res));
      if (err instanceof PlumAuthError) this.onAuthError?.(err);
      throw err;
    }
    return res;
  }
}

export class AuthApi {
  constructor(private client: PlumClient) {}

  /**
   * Mint a Personal Access Token. Requires a live session (call `login`
   * first). Store `result.token` — it is shown exactly once. Prefer scopes
   * `["read","write"]`; never request `admin` from an app.
   */
  async createToken(opts: {
    name: string;
    scopes: TokenScope[];
    expiresInDays?: number;
  }): Promise<CreatedToken> {
    const res = await this.client.request("/api/auth/tokens", {
      method: "POST",
      json: opts,
    });
    return responseJSON<CreatedToken>(res);
  }

  async listTokens(): Promise<TokenInfo[]> {
    const res = await this.client.request("/api/auth/tokens");
    return responseJSON<TokenInfo[]>(res);
  }

  async revokeToken(id: string): Promise<void> {
    await this.client.request(`/api/auth/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /** Who does the current credential belong to? Also a cheap connectivity check. */
  async me(): Promise<{ id: string; username?: string; email?: string; displayName?: string }> {
    const res = await this.client.request("/api/auth/me");
    // The box wraps the profile: {"user": {...}}
    const body = responseJSON<{ user?: { id: string } } & { id?: string }>(res);
    return (body.user ?? body) as { id: string; username?: string; email?: string; displayName?: string };
  }

  /** Discard the box-side session (call after minting a PAT). */
  async logout(): Promise<void> {
    await this.client.request("/api/auth/logout", { method: "POST" });
  }
}
