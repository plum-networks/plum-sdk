// Node example: PLUM_BASE_URL + PLUM_PAT env vars, then:
//   node examples/quickstart.mjs
import { PlumClient } from "../dist/index.js";

const client = new PlumClient({
  baseUrl: process.env.PLUM_BASE_URL,
  token: process.env.PLUM_PAT,
});

const me = await client.auth.me();
console.log("connected as", me.username ?? me.id);

const dir = `/sdk-quickstart`;
await client.drive.ensureDir(dir);
await client.drive.upload(`${dir}/hello.md`, `# hello from @plumbox/client\n${new Date().toISOString()}\n`, {
  overwrite: true,
});

for await (const f of client.drive.listAll(dir, { recursive: true, hash: true })) {
  console.log(f.isDir ? "dir " : "file", f.path, f.hash ?? "");
}
