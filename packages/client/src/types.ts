/** One entry from `drive.list` / `drive.listAll`. */
export interface DriveEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  /** RFC 3339 timestamp as reported by the box. */
  modTime: string;
  /**
   * SHA-256 of file content — present only when requested with `hash: true`
   * AND the file has been indexed by the box (files uploaded before hash
   * indexing simply omit it; fall back to size+modTime comparison).
   */
  hash?: string;
}

export interface TokenInfo {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

export interface CreatedToken extends TokenInfo {
  /** Plaintext PAT (`plum_pat_…`) — returned exactly once at creation. */
  token: string;
}

export interface TrashEntry {
  id: string;
  [key: string]: unknown;
}

export interface FileVersion {
  id: string;
  version_no?: number;
  [key: string]: unknown;
}

export type TokenScope = "read" | "write" | "admin";

/**
 * Scopes a registered companion app may ask the box owner for (OAuth). One
 * vocabulary on every surface — the developer console's client registration,
 * the box's consent screen and the token it mints:
 *
 * - `files:app`    read and write ONE folder the box makes for the app
 *                  (`app_folder` in the token response, e.g.
 *                  `/Apps/Obsidian Sync`) and nothing else — not the rest
 *                  of the drive, not the trash. The least a sync app needs.
 * - `files:read`   read the user's files
 * - `files:write`  change files (implies files:read)
 * - `user:profile` read the signed-in user's profile only
 * - `service:call:<app_id>` call that app's box-side service
 *
 * `read` / `write` are the older spellings and still work (`write` =
 * files:read + files:write). `admin` is never delegated to an app.
 */
export type OAuthScope =
  | "files:app"
  | "files:read"
  | "files:write"
  | "user:profile"
  | `service:call:${string}`
  | "read"
  | "write";

/** GET /api/apps/{id}/status — the app's box-side service, when it has one. */
export interface AppServiceStatus {
  state: string;
  [key: string]: unknown;
}

/** One SKU of an app's entitlement view. */
export interface SkuEntitlement {
  sku: string;
  kind: string;
  /** RFC 3339, or "" when the entitlement never expires. */
  expires_at: string;
  active: boolean;
}

/** GET /api/apps/{id}/entitlement — the store receipts this box holds for the app. */
export interface AppEntitlement {
  skus: SkuEntitlement[];
  /** When the box last refreshed its receipts from the store ("" = never). */
  refreshed_at: string;
  /** True when the box could not refresh for two days; apps decide how strict to be. */
  stale: boolean;
}

/** Result of `client.apps.ensureServiceInstalled()`. */
export type EnsureServiceResult =
  | { installed: true; status: AppServiceStatus }
  | {
      installed: false;
      /** Deep link that opens the Plum app on the store page for this app. */
      installUrl: string;
      /** The box's own web UI, for a device without the Plum app. */
      webUrl: string;
    };

/**
 * What the box's token endpoint hands back, from `exchangeCode` or
 * `refreshTokens` (and to `PlumClient`'s `onTokens`). Persist all of it.
 *
 * A box from before access tokens expired answers with
 * `accessToken` + `scope` only: such a token never expires and has no refresh
 * token — keep using it as it is.
 */
export interface OAuthTokens {
  /** The bearer token (`plum_pat_…`). */
  accessToken: string;
  /** Always `"bearer"`. */
  tokenType: string;
  /** The scopes granted, space-separated (may be fewer than requested). */
  scope: string;
  /**
   * Trade it for a new token set with `refreshTokens` (PlumClient does it for
   * you). It ROTATES: every refresh returns a new one and the old one stops
   * working, so always store the newest. It lapses after 90 days unused.
   * Absent from older boxes: the access token then never expires.
   */
  refreshToken?: string;
  /**
   * When the access token expires, in ms since the epoch on THIS device's
   * clock (computed from the box's `expires_in` on receipt). Absent: no
   * known expiry.
   */
  expiresAt?: number;
  /**
   * Present when `files:app` was granted: the absolute drive path the token
   * may read and write under (e.g. `/Apps/Obsidian Sync`). The box creates
   * the folder before it issues the token. Paths you send stay absolute
   * drive paths inside it (`/Apps/Obsidian Sync/MyVault/note.md`).
   */
  appFolder?: string;
}

export interface TokenStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ListOptions {
  /** Include every descendant (flat), not just direct children. */
  recursive?: boolean;
  /** Include indexed SHA-256 content hashes. */
  hash?: boolean;
  /** Server-side filename/path search. */
  q?: string;
  limit?: number;
  offset?: number;
  sort?: "name" | "size" | "modified" | "type" | "path";
  order?: "asc" | "desc";
}

export interface UploadOptions {
  /**
   * Replace the file at the exact name (previous content is kept as a
   * version snapshot on the box). Without it, a name collision creates
   * "name (2).ext" — NOT what a sync client wants.
   */
  overwrite?: boolean;
  contentType?: string;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}
