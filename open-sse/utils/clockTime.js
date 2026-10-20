// Local HH:MM:SS (24h) for console log lines.
// Intl-backed toLocaleTimeString costs ~0.2ms per call and runs several times
// per gateway request; this hand-built form prints the same zero-padded text
// (midnight is always "00", where some ICU builds printed "24") (YAN-1106).
const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);

export function clockTime(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}
