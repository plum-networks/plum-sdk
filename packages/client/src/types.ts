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
