// Shared outbound IP policy (SSRF guard) for remote image fetches and budget
// webhooks. `isPrivateIp` blocks every private/reserved address; budget
// webhooks may additionally reach private networks with an instance opt-in,
// but link-local and cloud metadata addresses stay blocked regardless.
import { isIP, BlockList } from "node:net";

// IPs that must never be fetched (SSRF guard). BlockList semantics replace the
// hand-rolled prefix checks and cover ::/128, deprecated ::/96, fec0::/10,
// multicast, TEST-NET, reserved ranges, etc.
const BLOCKED_SUBNETS = new BlockList();
const blockSubnet = (list, cidr, family) => {
  const [address, prefix] = cidr.split("/");
  list.addSubnet(address, Number(prefix), family);
};
for (const subnet of [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/29",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
])
  blockSubnet(BLOCKED_SUBNETS, subnet, "ipv4");
for (const subnet of [
  "::/96",
  "::1/128",
  "64:ff9b::/96",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
])
  blockSubnet(BLOCKED_SUBNETS, subnet, "ipv6");

// Private networks an operator may opt in to (RFC1918, CGNAT, loopback, ULA).
// Metadata addresses inside these ranges are excluded by ALWAYS_BLOCKED_SUBNETS,
// which is checked first.
export const PRIVATE_NETWORK_SUBNETS = new BlockList();
for (const subnet of [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "127.0.0.0/8",
])
  blockSubnet(PRIVATE_NETWORK_SUBNETS, subnet, "ipv4");
for (const subnet of ["::1/128", "fc00::/7"]) blockSubnet(PRIVATE_NETWORK_SUBNETS, subnet, "ipv6");

// Never reachable, opt-in or not: link-local and cloud metadata endpoints.
export const ALWAYS_BLOCKED_SUBNETS = new BlockList();
for (const subnet of ["169.254.0.0/16", "100.100.100.200/32"])
  blockSubnet(ALWAYS_BLOCKED_SUBNETS, subnet, "ipv4");
for (const subnet of ["fe80::/10", "fd00:ec2::254/128"])
  blockSubnet(ALWAYS_BLOCKED_SUBNETS, subnet, "ipv6");

// Expand an IPv6 address (optionally with a dotted IPv4 tail) to 8 hextets.
function expandIPv6(ip) {
  let text = ip.toLowerCase();
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail = ""] = text.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = text.includes("::") && tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array(Math.max(fill, 0)).fill("0"), ...tailParts];
  return parts.length === 8 ? parts.map((part) => Number.parseInt(part || "0", 16)) : null;
}

// BlockList only matches v4-mapped v6 against v6 ranges. Canonicalize every
// ::ffff:0:0/96 (mapped) and ::ffff:0:0:0/96 (translated) spelling to dotted
// IPv4 so it is checked against the v4 ranges.
export function normalizeIPv4Mapped(ip) {
  if (isIP(ip) !== 6) return ip;
  const h = expandIPv6(ip);
  if (!h) return ip;
  const mapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff;
  const translated = h.slice(0, 4).every((x) => x === 0) && h[4] === 0xffff && h[5] === 0;
  if (!mapped && !translated) return ip;
  return [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff].join(".");
}

// True if an IPv4/IPv6 address is private/reserved (SSRF target).
export function isPrivateIp(ip) {
  const normalized = normalizeIPv4Mapped(ip || "");
  const family = isIP(normalized);
  if (!family) return true;
  try {
    return BLOCKED_SUBNETS.check(normalized, family === 6 ? "ipv6" : "ipv4");
  } catch {
    return true; // unparseable address → do not fetch.
  }
}

// True if a webhook may connect to `ip`. Public addresses always; private
// networks only with `allowPrivate`; link-local, metadata and every other
// reserved range never.
export function isEgressAllowedIp(ip, { allowPrivate = false } = {}) {
  const normalized = normalizeIPv4Mapped(ip || "");
  const family = isIP(normalized);
  if (!family) return false;
  const type = family === 6 ? "ipv6" : "ipv4";
  try {
    if (ALWAYS_BLOCKED_SUBNETS.check(normalized, type)) return false;
    if (!isPrivateIp(normalized)) return true;
    return allowPrivate && PRIVATE_NETWORK_SUBNETS.check(normalized, type);
  } catch {
    return false;
  }
}
