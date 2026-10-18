// Pure, dependency-free helpers that turn a raw User-Agent / client IP into
// values safe to store and show on the sessions list. Output comes only from
// fixed enums (UA) or a validated address (IP); raw input is never echoed.
import { isIP } from "node:net";

// Order matters: Edge/Opera UAs also contain "chrome"; Chrome UAs contain "safari".
const BROWSERS = [
  ["Edge", ["edg/", "edga/", "edgios/", "edge/"]],
  ["Opera", ["opr/", "opera"]],
  ["Firefox", ["firefox/", "fxios/"]],
  ["Chrome", ["chrome/", "crios/"]],
  ["Safari", ["safari/"]],
];

// Order matters: iOS UAs contain "like mac os x"; Android UAs contain "linux".
const SYSTEMS = [
  ["iOS", ["iphone", "ipad", "ipod"]],
  ["Android", ["android"]],
  ["Windows", ["windows"]],
  ["ChromeOS", ["cros"]],
  ["macOS", ["macintosh", "mac os x"]],
  ["Linux", ["linux", "x11"]],
];

function pick(table, haystack, fallback) {
  for (const [name, needles] of table) {
    if (needles.some((n) => haystack.includes(n))) return name;
  }
  return fallback;
}

/**
 * @param {unknown} ua Raw User-Agent header value.
 * @returns {string} e.g. "Firefox on Linux"; "Unknown device" when absent.
 */
export function describeDevice(ua) {
  if (typeof ua !== "string" || ua.trim() === "") return "Unknown device";
  const haystack = ua.slice(0, 256).toLowerCase();
  return `${pick(BROWSERS, haystack, "Browser")} on ${pick(SYSTEMS, haystack, "Unknown OS")}`;
}

// Eight 16-bit groups from a valid IPv6 string (handles "::" and a dotted IPv4 tail).
function expandIPv6(ip) {
  let s = ip.split("%")[0];
  const tail = s.slice(s.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const o = tail.split(".").map(Number);
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    s = `${s.slice(0, s.length - tail.length)}${hi}:${lo}`;
  }
  const [head, rest] = s.split("::");
  const a = head ? head.split(":") : [];
  if (rest === undefined) return a.map((g) => Number.parseInt(g, 16));
  const b = rest ? rest.split(":") : [];
  const zeros = new Array(8 - a.length - b.length).fill("0");
  return [...a, ...zeros, ...b].map((g) => Number.parseInt(g, 16));
}

/**
 * Coarsen an address so the stored value is not a precise client identifier.
 * @param {unknown} ip
 * @returns {string|null} "a.b.c.0/24", "xxxx:xxxx:xxxx::/48", or null.
 */
export function coarseIp(ip) {
  if (typeof ip !== "string") return null;
  const family = isIP(ip);
  if (family === 0) return null;
  if (family === 4) {
    const [a, b, c] = ip.split(".");
    return `${a}.${b}.${c}.0/24`;
  }
  const g = expandIPv6(ip);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.0/24`;
  }
  return `${g[0].toString(16)}:${g[1].toString(16)}:${g[2].toString(16)}::/48`;
}
