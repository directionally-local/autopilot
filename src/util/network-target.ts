/**
 * Where a URL points on the network. web_fetch and browser_fetch run
 * without a prompt, so a prompt-injected model could otherwise read cloud
 * metadata credentials (http://169.254.169.254/...), services on
 * localhost (autopilot's own `serve` API, the Aster cell bridge) or the
 * private network, and pull the response into its context. Fetching
 * http://localhost:3000 to check a dev server is legitimate, so such
 * targets are not blocked: they need the user's permission, per host.
 *
 * Hostnames are resolved (all addresses), so a name that points at a
 * private address (`metadata.google.internal`, an attacker's DNS name
 * answering 127.0.0.1) is caught as well as an IP literal. WHATWG URL
 * parsing already normalizes the odd IPv4 spellings (2130706433, 0x7f.1,
 * 0177.0.0.1, 127.1) to dotted quads and IPv6 to its compressed form.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AddressClass = "loopback" | "link-local" | "private" | "unspecified" | "reserved" | "public";

export interface ResolvedAddress {
  address: string;
  class: AddressClass;
}

export interface NetworkTarget {
  /** URL.host: hostname plus port, the unit approvals are given for. */
  host: string;
  /** Hostname without IPv6 brackets. */
  hostname: string;
  addresses: ResolvedAddress[];
  /** The first non-public address, or null when every address is public
   *  (or the name did not resolve; the fetch then fails on its own). */
  nonPublic: ResolvedAddress | null;
}

export type Lookup = (hostname: string) => Promise<string[]>;

const defaultLookup: Lookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

let activeLookup: Lookup = defaultLookup;

/** Test hook: replace DNS resolution. Pass null to restore the default. */
export function setLookupForTests(fn: Lookup | null): void {
  activeLookup = fn ?? defaultLookup;
}

/** Parses `url` and throws unless it is an absolute http(s) URL. */
export function parseWebUrl(url: unknown, toolName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`${toolName} needs an absolute http(s) URL, got: ${String(url)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${toolName} only opens http(s) URLs, not ${parsed.protocol} (use the read tool for local files)`);
  }
  return parsed;
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

/** Eight 16-bit groups, or null. Accepts `::`, an embedded dotted quad and a zone id. */
function parseIPv6(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // Rewrite an embedded dotted quad (::ffff:1.2.3.4) as two hex groups.
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] =>
    part ? part.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)) : [];
  const head = parseGroups(halves[0]!);
  let groups = head;
  if (halves.length === 2) {
    const rest = parseGroups(halves[1]!);
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

function classifyIPv4([a, b, c]: number[]): AddressClass {
  if (a === 0) return "unspecified"; // 0.0.0.0/8 ("this network"; 0.0.0.0 reaches localhost)
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local"; // includes cloud metadata 169.254.169.254
  if (a === 10) return "private";
  if (a === 172 && b! >= 16 && b! <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b! >= 64 && b! <= 127) return "private"; // CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return "reserved"; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking 198.18/15
  if (a! >= 224) return "reserved"; // multicast, 240/4, broadcast
  return "public";
}

function classifyIPv6(g: number[]): AddressClass {
  const v4 = (hi: number, lo: number): number[] => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return "unspecified";
  if (zeros(0, 7) && g[7] === 1) return "loopback";
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0)) return classifyIPv4(v4(g[6]!, g[7]!));
  // NAT64 64:ff9b::/96 and 6to4 2002::/16 carry an IPv4 address
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return classifyIPv4(v4(g[6]!, g[7]!));
  if (g[0] === 0x2002) {
    const inner = classifyIPv4(v4(g[1]!, g[2]!));
    if (inner !== "public") return inner;
  }
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // fc00::/7 ULA, includes AWS metadata fd00:ec2::254
  if ((g[0]! & 0xffc0) === 0xfec0) return "private"; // deprecated site-local fec0::/10
  if ((g[0]! & 0xff00) === 0xff00) return "reserved"; // multicast
  return "public";
}

/** Classifies an IP address literal (IPv4, or IPv6 with or without brackets). */
export function classifyAddress(ip: string): AddressClass {
  const bare = ip.replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(bare);
  if (v4) return classifyIPv4(v4);
  const v6 = bare.includes(":") ? parseIPv6(bare) : null;
  if (v6) return classifyIPv6(v6);
  // Not something we can parse: do not call it public.
  return "reserved";
}

function isLocalhostName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost");
}

/**
 * Resolves the URL's host and classifies every address it maps to.
 * Throws for a non-http(s) URL.
 */
export async function resolveNetworkTarget(url: string | URL, toolName = "web_fetch"): Promise<NetworkTarget> {
  const parsed = typeof url === "string" ? parseWebUrl(url, toolName) : url;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  let addresses: ResolvedAddress[];
  if (isIP(hostname)) {
    addresses = [{ address: hostname, class: classifyAddress(hostname) }];
  } else if (isLocalhostName(hostname)) {
    // RFC 6761: localhost names are loopback whatever DNS says.
    addresses = [{ address: hostname, class: "loopback" }];
  } else {
    let resolved: string[] = [];
    try {
      resolved = await activeLookup(hostname);
    } catch {
      // Unresolvable: nothing to classify; the fetch itself will fail.
    }
    addresses = resolved.map((address) => ({ address, class: classifyAddress(address) }));
  }
  return {
    host: parsed.host,
    hostname,
    addresses,
    nonPublic: addresses.find((a) => a.class !== "public") ?? null,
  };
}

/** Human-readable description of a non-public target, for reasons and errors. */
export function describeNonPublic(target: NetworkTarget): string | null {
  const hit = target.nonPublic;
  if (!hit) return null;
  const where = hit.address === target.hostname ? hit.address : `${target.hostname} → ${hit.address}`;
  return `a local or private network address (${where}, ${hit.class})`;
}

/**
 * The permission reason for fetching `url`: non-null when it points at a
 * loopback, link-local, private, unspecified or reserved address. Invalid
 * and non-http(s) URLs return null; the tool rejects them when it runs.
 */
export async function networkTargetReason(url: unknown, toolName: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = parseWebUrl(url, toolName);
  } catch {
    return null;
  }
  const described = describeNonPublic(await resolveNetworkTarget(parsed, toolName));
  return described ? `fetches ${described}` : null;
}

/** The unit a network permission is approved for: the URL's host:port. */
export function networkPermissionTarget(url: unknown): string {
  try {
    const parsed = new URL(String(url));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return String(url);
  }
}
