import type { PlumClient } from "./client.js";
import { buildMultipart, responseJSON, toArrayBuffer } from "./http.js";
import type { DriveEntry, FileVersion, ListOptions, TrashEntry, UploadOptions } from "./types.js";

/** Files above this size go through the resumable chunked-upload protocol. */
const CHUNKED_THRESHOLD = 8 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024;
const PAGE_SIZE = 1000; // server maxListLimit

interface ListPage {
  items: DriveEntry[];
  total: number;
  limit: number;
  offset: number;
}

function dirname(path: string): string {
  const norm = "/" + path.replace(/^\/+/, "").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx <= 0 ? "/" : norm.slice(0, idx);
}

function basename(path: string): string {
  const norm = path.replace(/\/+$/, "");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

export class DriveApi {
  constructor(private client: PlumClient) {}

  /** List one page. Pass limit/offset for pagination; see `listAll` for iteration. */
  async list(path: string, opts: ListOptions = {}): Promise<ListPage> {
    const params = new URLSearchParams({ path: path || "/" });
    if (opts.recursive) params.set("recursive", "1");
    if (opts.hash) params.set("hash", "1");
    if (opts.q) params.set("q", opts.q);
    if (opts.sort) params.set("sort", opts.sort);
    if (opts.order) params.set("order", opts.order);
    // Always paginate so the response shape is stable ({items,total,...}).
    params.set("limit", String(opts.limit ?? PAGE_SIZE));
    params.set("offset", String(opts.offset ?? 0));
    const res = await this.client.request(`/api/drive/list?${params}`);
    return responseJSON<ListPage>(res);
  }

  /** Iterate every entry under `path`, transparently walking pages. */
  async *listAll(
    path: string,
    opts: Omit<ListOptions, "limit" | "offset"> = {},
  ): AsyncGenerator<DriveEntry, void, void> {
    let offset = 0;
    for (;;) {
      const page = await this.list(path, { ...opts, limit: PAGE_SIZE, offset });
      for (const item of page.items) yield item;
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) return;
    }
  }

  async download(path: string): Promise<ArrayBuffer> {
    const params = new URLSearchParams({ path });
    const res = await this.client.request(`/api/drive/download?${params}`);
    return res.body;
  }

  /**
   * Upload `data` as the file at `path` (full drive path including filename).
   * Small files go as one multipart POST; larger ones use the resumable
   * chunked protocol automatically. With `overwrite: true` the file is
   * replaced in place (previous content becomes a version snapshot) — without
   * it a name collision creates "name (2).ext".
   */
  async upload(
    path: string,
    data: ArrayBuffer | Uint8Array | string,
    opts: UploadOptions = {},
  ): Promise<DriveEntry> {
    const buf = toArrayBuffer(data);
    const dir = dirname(path);
    const name = basename(path);
    if (!name) throw new Error("upload path must include a filename");

    if (buf.byteLength > CHUNKED_THRESHOLD && !opts.overwrite) {
      return this.uploadChunked(dir, name, buf, opts);
    }
    // NOTE: overwrite semantics only exist on the single-shot endpoint today,
    // so overwrite uploads always take this path regardless of size.
    const fields: Record<string, string> = { path: dir };
    if (opts.overwrite) fields.overwrite = "1";
    const { body, contentType } = buildMultipart(fields, {
      field: "file",
      name,
      data: buf,
      contentType: opts.contentType,
    });
    const res = await this.client.request("/api/drive/upload", {
      method: "POST",
      body,
      headers: { "content-type": contentType },
    });
    opts.onProgress?.(buf.byteLength, buf.byteLength);
    const out = responseJSON<{ status: string; path: string; name: string }>(res);
    return {
      name: out.name,
      path: out.path,
      isDir: false,
      size: buf.byteLength,
      modTime: new Date().toISOString(),
    };
  }

  private async uploadChunked(
    dir: string,
    name: string,
    buf: ArrayBuffer,
    opts: UploadOptions,
  ): Promise<DriveEntry> {
    const initRes = await this.client.request("/api/uploads/init", {
      method: "POST",
      json: {
        target: "drive",
        path: dir,
        filename: name,
        size: buf.byteLength,
        contentType: opts.contentType ?? "application/octet-stream",
      },
    });
    const { uploadId } = responseJSON<{ uploadId: string; chunkSize?: number }>(initRes);

    const total = buf.byteLength;
    let sent = 0;
    let finalBody: unknown = null;
    while (sent < total) {
      const end = Math.min(sent + CHUNK_SIZE, total);
      const res = await this.client.request(`/api/uploads/${encodeURIComponent(uploadId)}`, {
        method: "PATCH",
        body: buf.slice(sent, end),
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes ${sent}-${end - 1}/${total}`,
        },
      });
      sent = end;
      opts.onProgress?.(sent, total);
      if (sent >= total) finalBody = responseJSON(res);
    }
    const placed = (finalBody ?? {}) as { path?: string; name?: string };
    return {
      name: placed.name ?? name,
      path: placed.path ?? `${dir === "/" ? "" : dir}/${name}`,
      isDir: false,
      size: total,
      modTime: new Date().toISOString(),
    };
  }

  /** Create one directory. Parent must exist — see `ensureDir` for mkdir -p. */
  async mkdir(path: string): Promise<void> {
    await this.client.request("/api/drive/mkdir", {
      method: "POST",
      json: { path: dirname(path), name: basename(path) },
    });
  }

  /** mkdir -p: create every missing segment of `path`. */
  async ensureDir(path: string): Promise<void> {
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const seg of segments) {
      current += "/" + seg;
      try {
        await this.mkdir(current);
      } catch (err) {
        // Already-exists is fine; surface anything else.
        const status = (err as { status?: number }).status;
        if (status !== 409 && status !== 500) throw err;
      }
    }
  }

  /** Rename within the same directory. For cross-directory moves use `move`. */
  async rename(path: string, newName: string): Promise<void> {
    await this.client.request("/api/drive/rename", {
      method: "POST",
      json: { path, name: newName },
    });
  }

  /** Move a file or directory to an arbitrary path (destination parent must exist). */
  async move(path: string, newPath: string): Promise<void> {
    await this.client.request("/api/drive/move", {
      method: "POST",
      json: { path, newPath },
    });
  }

  /** Delete (moves to the box trash — recoverable from the Drive UI). */
  async remove(path: string): Promise<void> {
    const params = new URLSearchParams({ path });
    await this.client.request(`/api/drive/delete?${params}`, { method: "DELETE" });
  }

  readonly trash = {
    list: async (): Promise<TrashEntry[]> => {
      const res = await this.client.request("/api/drive/trash/list");
      return responseJSON<TrashEntry[]>(res);
    },
    restore: async (id: string): Promise<void> => {
      await this.client.request("/api/drive/restore", { method: "POST", json: { id } });
    },
    empty: async (): Promise<void> => {
      await this.client.request("/api/drive/trash/empty", { method: "POST" });
    },
  };

  readonly versions = {
    list: async (path: string): Promise<FileVersion[]> => {
      const params = new URLSearchParams({ path });
      const res = await this.client.request(`/api/drive/versions?${params}`);
      return responseJSON<FileVersion[]>(res);
    },
    restore: async (path: string, versionId: string): Promise<void> => {
      await this.client.request("/api/drive/restore-version", {
        method: "POST",
        json: { path, versionId },
      });
    },
  };
}
