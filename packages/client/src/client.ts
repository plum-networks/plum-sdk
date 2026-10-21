import { fetchAdapter } from "./adapters/fetch.js";
import { errorFromResponse, PlumApiError, PlumAuthError } from "./errors.js";
import type { HttpAdapter, HttpResponse } from "./http.js";
import { joinURL, parseSessionCookie, responseJSON, responseText } from "./http.js";
import { DriveApi } from "./drive.js";
import { AppsApi } from "./apps.js";
import type { CreatedToken, OAuthTokens, TokenInfo, TokenScope, TokenStorage } from "./types.js";
import { isForeignUrl, plumEnvironment } from "./env.js";
import { isPlumIssuer, refreshTokens } from "./oauth.js";

export interface PlumClientOptions {
  /** `https://pb-<sub>.plumbox.me` (production) — the `iss` of an OAuth callback, or stored settings. */
  baseUrl: string;
  /**
   * Access token (`plum_pat_…`): `OAuthTokens.accessToken`, or a PAT. When
   * set, every request uses Bearer auth.
   */
  token?: string;
  /**
   * `OAuthTokens.refreshToken`. With it the client keeps the access token
   * fresh by itself: it refreshes shortly before `expiresAt`, and once when a
   * request comes back 401 (then sends that request again). Needs `clientId`
   * and the box's verified `iss`. Every refresh rotates the refresh token —
   * persist the new set in `onTokens`.
   */
  refreshToken?: string;
  /** `OAuthTokens.expiresAt` (ms since the epoch) — when `token` expires. */
  expiresAt?: number;
  /** `OAuthTokens.appFolder`, when `files:app` was granted (read it back from `appFolder`). */
  appFolder?: string;
  /** The client id the tokens were issued to. Required with a refresh token. */
  clientId?: string;
  /**
   * The `iss` the sign-in was checked against — the box's canonical address
   * (`https://pb-….plumbox.me`). Default: `baseUrl`. Refreshes go to
   * `<iss>/api/oauth/token` and nowhere else, so with a refresh token this
   * must pass `isPlumIssuer` (pass it explicitly when `baseUrl` is a LAN
   * address).
   */
  iss?: string;
  /**
   * Called with the new token set after every refresh, before the request
   * that needed it is sent again. PERSIST IT: the refresh token you stored
   * before no longer works (after a 60-second grace, using it ends the whole
   * connection). A throw from here is ignored — the client already uses the
   * new tokens.
   */
  onTokens?: (tokens: OAuthTokens) => void | Promise<void>;
  /** Transport. Defaults to global-fetch. Obsidian: `injectedAdapter(requestUrl)`. */
  http?: HttpAdapter;
  /**
   * Optional persistence for the tokens (key: "plumbox.token"). `setToken`,
   * `loadToken` and every refresh use it; the token set is stored as JSON (a
   * plain-string value from an older version still loads).
   */
  tokenStorage?: TokenStorage;
  /**
   * The credential is no good and the user has to connect again: a 401 the
   * client could not cure by refreshing, or a refresh the box refused
   * (`PlumAuthError` code `invalid_grant`). Hook your re-login UI here. Fires
   * once per credential, however many requests were in flight. A 403
   * (`PlumForbiddenError`: not allowed, credential fine) does NOT fire it.
   */
  onAuthError?: (err: PlumAuthError) => void;
  /**
   * The Plum environment, by box domain: `plumbox.me` (default, production) or
   * `staging.plumbox.me`. A `baseUrl` of another environment's box is refused;
   * a LAN address or localhost is not any environment's and is accepted.
   */
  boxDomain?: string;
  /** The environment's portal (default: its own, `https://plumbox.me` in production). */
  portalOrigin?: string;
}

const TOKEN_STORAGE_KEY = "plumbox.token";
/** Refresh this long before the access token runs out. */
const REFRESH_MARGIN_MS = 60_000;

type RequestOptions = {
  method?: string;
  json?: unknown;
  body?: string | ArrayBuffer | Uint8Array;
  headers?: Record<string, string>;
  allowStatus?: number[];
};

/**
 * Whether a request body can be sent a second time unchanged. Everything this
 * SDK builds is (strings and in-memory buffers); anything else (a stream an
 * adapter was handed by a cast) is not retried.
 */
function isReplayable(body: unknown): boolean {
  if (body === undefined || typeof body === "string") return true;
  if (ArrayBuffer.isView(body)) return true;
  return Object.prototype.toString.call(body) === "[object ArrayBuffer]";
}

/** A tokenStorage value: the JSON token set, or a bare token from before 0.4.0. */
function parseStoredTokens(stored: string): OAuthTokens | null {
  const s = stored.trim();
  if (!s) return null;
  if (!s.startsWith("{")) return { accessToken: s, tokenType: "bearer", scope: "" };
  try {
    const t = JSON.parse(s) as Partial<OAuthTokens>;
    if (typeof t.accessToken !== "string" || !t.accessToken) return null;
    const out: OAuthTokens = {
      accessToken: t.accessToken,
      tokenType: typeof t.tokenType === "string" && t.tokenType ? t.tokenType : "bearer",
      scope: typeof t.scope === "string" ? t.scope : "",
    };
    if (typeof t.refreshToken === "string" && t.refreshToken) out.refreshToken = t.refreshToken;
    if (typeof t.expiresAt === "number" && Number.isFinite(t.expiresAt)) out.expiresAt = t.expiresAt;
    if (typeof t.appFolder === "string" && t.appFolder) out.appFolder = t.appFolder;
    return out;
  } catch {
    return null;
  }
}

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
  /** The environment's box domain (`plumbox.me` in production). */
  readonly boxDomain: string;
  /** The environment's portal — pass it to `beginAuthorization` as `portalUrl`. */
  readonly portalOrigin: string;
  readonly drive: DriveApi;
  readonly auth: AuthApi;
  readonly apps: AppsApi;

  private http: HttpAdapter;
  private token?: string;
  private refreshToken?: string;
  private expiresAt?: number;
  private scope = "";
  private folder?: string;
  private readonly clientId?: string;
  private readonly iss: string;
  private sessionCookie: string | null = null;
  private tokenStorage?: TokenStorage;
  private onAuthError?: (err: PlumAuthError) => void;
  private onTokens?: (tokens: OAuthTokens) => void | Promise<void>;
  /** The refresh every waiting request shares (single flight). */
  private refreshing: Promise<void> | null = null;
  /** Bumped whenever the tokens are replaced from outside, so a late refresh result is dropped. */
  private generation = 0;
  /** The access token `onAuthError` last fired for (it fires once per credential). */
  private authErrorToken: string | undefined;

  constructor(opts: PlumClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const env = plumEnvironment(opts.boxDomain);
    if (isForeignUrl(this.baseUrl, env)) {
      throw new Error(`PlumClient: ${this.baseUrl} is not a box of ${env.boxDomain}`);
    }
    this.portalOrigin = (opts.portalOrigin ?? env.portalOrigin).replace(/\/+$/, "");
    if (isForeignUrl(this.portalOrigin, env)) {
      throw new Error(`PlumClient: ${this.portalOrigin} is not the portal of ${env.boxDomain}`);
    }
    this.boxDomain = env.boxDomain;
    this.http = opts.http ?? fetchAdapter;
    this.clientId = opts.clientId?.trim() || undefined;
    this.iss = opts.iss ?? this.baseUrl;
    this.tokenStorage = opts.tokenStorage;
    this.onAuthError = opts.onAuthError;
    this.onTokens = opts.onTokens;
    if (opts.token || opts.refreshToken) {
      this.adopt({
        accessToken: opts.token ?? "",
        tokenType: "bearer",
        scope: "",
        refreshToken: opts.refreshToken,
        // A refresh token without an access token: refresh before the first request.
        expiresAt: opts.token ? opts.expiresAt : 0,
        appFolder: opts.appFolder,
      });
    }
    this.drive = new DriveApi(this);
    this.auth = new AuthApi(this);
    this.apps = new AppsApi(this);
  }

  /**
   * Load previously stored tokens from tokenStorage (a token set saved by
   * 0.4.0+, or a bare token saved by an older version). Returns true when found.
   */
  async loadToken(): Promise<boolean> {
    if (!this.tokenStorage) return false;
    const stored = await this.tokenStorage.get(TOKEN_STORAGE_KEY);
    const tokens = stored ? parseStoredTokens(stored) : null;
    if (!tokens) return false;
    this.adopt(tokens);
    return true;
  }

  /**
   * Adopt a token for all subsequent requests (and persist it when storage is
   * configured): a PAT string, or the whole `OAuthTokens` from `exchangeCode`
   * — pass the whole set so the client can refresh it.
   */
  async setToken(token: string | OAuthTokens): Promise<void> {
    const tokens: OAuthTokens = typeof token === "string" ? { accessToken: token, tokenType: "bearer", scope: "" } : token;
    this.adopt(tokens);
    await this.tokenStorage?.set(TOKEN_STORAGE_KEY, typeof token === "string" ? token : JSON.stringify(this.currentTokens()));
  }

  async clearToken(): Promise<void> {
    this.generation++;
    this.token = this.refreshToken = this.expiresAt = this.folder = undefined;
    this.scope = "";
    await this.tokenStorage?.delete(TOKEN_STORAGE_KEY);
  }

  get hasToken(): boolean {
    return !!this.token;
  }

  get hasSession(): boolean {
    return !!this.sessionCookie;
  }

  /** The folder a `files:app` token may use (`OAuthTokens.appFolder`), when known. */
  get appFolder(): string | undefined {
    return this.folder;
  }

  /**
   * Refresh the access token now. Concurrent callers (and requests that hit
   * a 401 meanwhile) share one refresh. Rejects with `PlumAuthError` code
   * `invalid_grant` when the connection is gone (and fires `onAuthError`), or
   * with a transport/`PlumApiError` when the box could not be reached (the
   * refresh token is still good).
   */
  refresh(): Promise<void> {
    if (!this.refreshToken) {
      return Promise.reject(new Error("PlumClient.refresh: this client holds no refresh token"));
    }
    return this.refreshShared();
  }

  private adopt(t: OAuthTokens): void {
    if (t.refreshToken) {
      if (!this.clientId) {
        throw new Error("PlumClient: a refresh token needs the clientId option (the client id the tokens were issued to)");
      }
      if (!isPlumIssuer(this.iss, this.boxDomain)) {
        throw new Error(
          `PlumClient: refreshing needs the box's verified iss (https://pb-….${this.boxDomain}); pass it as the iss option`,
        );
      }
    }
    this.generation++;
    this.token = t.accessToken;
    this.refreshToken = t.refreshToken || undefined;
    this.expiresAt = t.expiresAt;
    this.scope = t.scope ?? "";
    this.folder = t.appFolder || undefined;
  }

  private currentTokens(): OAuthTokens {
    const out: OAuthTokens = { accessToken: this.token ?? "", tokenType: "bearer", scope: this.scope };
    if (this.refreshToken) out.refreshToken = this.refreshToken;
    if (this.expiresAt !== undefined) out.expiresAt = this.expiresAt;
    if (this.folder) out.appFolder = this.folder;
    return out;
  }

  private refreshShared(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const sent = this.refreshToken;
    const generation = this.generation;
    if (!sent || !this.clientId) throw new Error("PlumClient: no refresh token");
    let next: OAuthTokens;
    try {
      next = await refreshTokens({
        iss: this.iss,
        clientId: this.clientId,
        refreshToken: sent,
        http: this.http,
        boxDomain: this.boxDomain,
      });
    } catch (err) {
      if (err instanceof PlumAuthError && err.code === "invalid_grant" && generation === this.generation) {
        // The connection is gone: stop sending a refresh token the box refuses.
        this.refreshToken = undefined;
        this.fireAuthError(err, this.token);
      }
      throw err;
    }
    // The tokens were replaced (setToken/clearToken) while this was in flight:
    // keep those — unless they are the very set this refresh rotated away
    // (re-loaded from storage), which no longer works.
    if (generation !== this.generation && this.refreshToken !== sent) return;
    this.token = next.accessToken;
    this.refreshToken = next.refreshToken;
    this.expiresAt = next.expiresAt;
    if (next.scope) this.scope = next.scope;
    if (next.appFolder) this.folder = next.appFolder;
    const tokens = this.currentTokens();
    try {
      await this.tokenStorage?.set(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
    } catch {
      // The new tokens are in use; a storage failure must not fail the request.
    }
    try {
      await this.onTokens?.(tokens);
    } catch {
      // Same: documented as ignored.
    }
  }

  private refreshDue(): boolean {
    return !!this.refreshToken && this.expiresAt !== undefined && Date.now() >= this.expiresAt - REFRESH_MARGIN_MS;
  }

  private fireAuthError(err: PlumAuthError, sentWith: string | undefined): void {
    if (sentWith !== undefined && sentWith === this.authErrorToken) return;
    this.authErrorToken = sentWith;
    this.onAuthError?.(err);
  }

  /**
   * First-factor login with the box account's email/username + password.
   * On success the client holds a session cookie (7-day TTL) — immediately
   * mint a PAT with `auth.createToken` and persist only that.
   *
   * @deprecated Connect with delegated OAuth instead (`beginAuthorization` →
   * `parseCallback` → `exchangeCode`), so the password is typed only on the
   * box's own page. A Plum Box v3 box can answer a sign-in from a new device
   * with a mail code (`requireSecondFactor`); this method cannot complete that
   * step and stops with `PlumApiError` code `second_factor_unsupported`.
   */
  async login(cred: { login: string; password: string }): Promise<LoginResult> {
    const res = await this.request("/api/auth/login", {
      method: "POST",
      json: { login: cred.login, password: cred.password },
      allowStatus: [200],
    });
    const body = responseJSON<{ requireTotp?: boolean; requireSecondFactor?: boolean; tempToken?: string }>(res);
    if (body.requireSecondFactor) {
      throw new PlumApiError(
        res.status,
        "this box asks a new device for a mail code, which PlumClient.login cannot answer — connect with delegated OAuth (beginAuthorization)",
        "second_factor_unsupported",
      );
    }
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

  /**
   * Internal: perform an API request with auth + error mapping.
   *
   * With a refresh token, an access token about to expire is refreshed first,
   * and a 401 is answered by one refresh (shared with every request waiting on
   * it) and one more try of the same request. A 401 is the box refusing the
   * credential before it reads the request, so the second try is not a
   * duplicate write; the body is sent again byte for byte. A body that cannot
   * be sent twice is not retried: the request fails with `PlumApiError` code
   * `token_refreshed` (status 401) once the token is fresh — send it again.
   */
  async request(path: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    // Due, or already under way (another request's 401): wait for the new token.
    if (this.refreshDue() || this.refreshing) {
      try {
        await this.refreshShared();
      } catch (err) {
        // Gone for good, or no longer usable at all: stop. A token that is
        // still valid for a few seconds is worth one try.
        if (err instanceof PlumAuthError || this.expiresAt === undefined || Date.now() >= this.expiresAt) throw err;
      }
    }
    let sentWith = this.token;
    let res = await this.send(path, opts);
    if (res.status === 401 && sentWith && this.refreshToken && !opts.allowStatus?.includes(401)) {
      // Another request may have refreshed already while this one was out.
      if (this.token === sentWith) await this.refreshShared();
      if (!isReplayable(opts.body)) {
        throw new PlumApiError(
          401,
          "the access token was refreshed, but this request's body cannot be sent twice — send it again",
          "token_refreshed",
        );
      }
      sentWith = this.token;
      res = await this.send(path, opts);
    }
    const ok = opts.allowStatus
      ? opts.allowStatus.includes(res.status)
      : res.status >= 200 && res.status < 300;
    if (!ok) {
      const err = errorFromResponse(res.status, responseText(res));
      if (err instanceof PlumAuthError) this.fireAuthError(err, sentWith);
      throw err;
    }
    return res;
  }

  private send(path: string, opts: RequestOptions): Promise<HttpResponse> {
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
    return this.http.request({
      url: joinURL(this.baseUrl, path),
      method: opts.method ?? "GET",
      headers,
      body,
    });
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
