// IP-literal classification for Dev issuers and loopback redirects, with the
// semantics of Go's net.ParseIP + IsLoopback/IsPrivate that the reference
// (oauth-issuer-v3-proto issuer.go, callback.go) uses.

/** 4 or 16 bytes, or null when `s` is not an IP literal (no brackets, no zone). */
export function parseIP(s: string): Uint8Array | null {
  return parseIPv4(s) ?? parseIPv6(s);
}

const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)"; // no leading zeros, as Go ≥ 1.17
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

function parseIPv4(s: string): Uint8Array | null {
  const m = IPV4.exec(s);
  return m ? new Uint8Array([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]) : null;
}

function parseIPv6(s: string): Uint8Array | null {
  if (!s.includes(":")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const parts = part.split(":");
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (i === parts.length - 1 && p.includes(".")) {
        const v4 = parseIPv4(p); // embedded IPv4 only as the last 32 bits
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  const n = head.length + tail.length;
  if (halves.length === 1 ? n !== 8 : n > 7) return null;
  const all = [...head, ...new Array<number>(8 - n).fill(0), ...tail];
  const out = new Uint8Array(16);
  all.forEach((g, i) => {
    out[2 * i] = g >> 8;
    out[2 * i + 1] = g & 0xff;
  });
  return out;
}

/** The IPv4 address inside an IPv4 or IPv4-mapped IPv6 literal (Go's To4). */
function to4(ip: Uint8Array): Uint8Array | null {
  if (ip.length === 4) return ip;
  for (let i = 0; i < 10; i++) if (ip[i] !== 0) return null;
  return ip[10] === 0xff && ip[11] === 0xff ? ip.subarray(12) : null;
}

/** 127.0.0.0/8 or ::1 (Go IsLoopback). */
export function isLoopbackIP(ip: Uint8Array): boolean {
  const v4 = to4(ip);
  if (v4) return v4[0] === 127;
  return ip.every((b, i) => b === (i === 15 ? 1 : 0));
}

/** 10/8, 172.16/12, 192.168/16, fc00::/7 (Go IsPrivate, RFC 1918 / RFC 4193). */
export function isPrivateIP(ip: Uint8Array): boolean {
  const v4 = to4(ip);
  if (v4) {
    return v4[0] === 10 || (v4[0] === 172 && (v4[1]! & 0xf0) === 16) || (v4[0] === 192 && v4[1] === 168);
  }
  return (ip[0]! & 0xfe) === 0xfc;
}

/**
 * Whether a WHATWG `URL.hostname` names this machine: `localhost`, or a
 * loopback IP literal (`127.x.x.x`, `[::1]`).
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const ip = parseIP(bare);
  return ip !== null && isLoopbackIP(ip);
}
