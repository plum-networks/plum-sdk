import { describe, expect, it } from "vitest";
import { PlumClient } from "../src/client.js";

/**
 * End-to-end against a REAL box (relay path or LAN). Opt-in:
 *
 *   PLUM_INTEGRATION=1 \
 *   PLUM_TEST_BASE_URL=https://pb-<sub>.plumbox.me \
 *   PLUM_TEST_PAT=plum_pat_... \
 *   pnpm --filter @plumbox/client test:integration
 */
const enabled = process.env.PLUM_INTEGRATION === "1";
const baseUrl = process.env.PLUM_TEST_BASE_URL ?? "";
const pat = process.env.PLUM_TEST_PAT ?? "";

describe.runIf(enabled && !!baseUrl && !!pat)("integration: drive round-trip", () => {
  const client = new PlumClient({ baseUrl, token: pat });
  const root = `/sdk-it-${Date.now()}`;

  it("connects and identifies", async () => {
    const me = await client.auth.me();
    expect(me.id).toBeTruthy();
  });

  it("full CRUD round-trip", async () => {
    await client.drive.ensureDir(`${root}/sub`);

    const v1 = await client.drive.upload(`${root}/note.md`, "# v1", { overwrite: true });
    expect(v1.path).toBe(`${root}/note.md`);

    // overwrite in place — no "(2)" copies
    const v2 = await client.drive.upload(`${root}/note.md`, "# v2", { overwrite: true });
    expect(v2.path).toBe(`${root}/note.md`);

    const body = new TextDecoder().decode(await client.drive.download(`${root}/note.md`));
    expect(body).toBe("# v2");

    const entries: string[] = [];
    let sawHash = false;
    for await (const e of client.drive.listAll(root, { recursive: true, hash: true })) {
      entries.push(e.path);
      if (e.path === `${root}/note.md` && e.hash) sawHash = true;
    }
    expect(entries).toContain(`${root}/note.md`);
    expect(entries).toContain(`${root}/sub`);
    expect(sawHash).toBe(true);

    await client.drive.move(`${root}/note.md`, `${root}/sub/note.md`);
    const moved = await client.drive.list(`${root}/sub`, { hash: true });
    expect(moved.items.map((i) => i.path)).toContain(`${root}/sub/note.md`);

    await client.drive.remove(root);
  }, 120_000);
});

describe.runIf(!enabled)("integration (skipped)", () => {
  it("set PLUM_INTEGRATION=1 PLUM_TEST_BASE_URL=... PLUM_TEST_PAT=... to run", () => {
    expect(true).toBe(true);
  });
});
