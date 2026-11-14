/**
 * Ağ hedef kuralları — arayüz tarafı (erken ve anlaşılır hata için). ASIL denetim Android kabuğundadır
 * (apps/mobile/app/lib/net_policy.dart); bu dosya onunla aynı kuralları uygular ama onun yerine geçmez.
 */
export type HttpPurpose = "relay" | "openai" | "local-ai";
export type Scope = "personal" | "business";

/** Kabuğun döndürebileceği politika kodları. */
export const POLICY_CODES = ["HOST_DENIED", "CLEARTEXT_BLOCKED", "TARGET_NOT_ALLOWED", "TARGET_FORBIDDEN", "REDIRECT_BLOCKED", "URL_INVALID", "URL_SCHEME", "PURPOSE_INVALID"] as const;
export type PolicyCode = (typeof POLICY_CODES)[number];
export const isPolicyCode = (c: string): c is PolicyCode => (POLICY_CODES as readonly string[]).includes(c);

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : undefined;
}

/** Özel ağ / loopback: 10/8, 172.16/12, 192.168/16, 127/8, 100.64/10, ::1, fc00::/7, "localhost". */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost") return true;
  const b = ipv4(h);
  if (b) {
    const [a, c] = b as [number, number, number, number];
    return a === 10 || a === 127 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 100 && c >= 64 && c <= 127);
  }
  if (h === "::1") return true;
  return /^f[cd][0-9a-f]{0,2}:/.test(h);
}

export function isForbiddenHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const b = ipv4(h);
  if (b) return b[0] === 0 || (b[0] === 169 && b[1] === 254) || (b[0] ?? 0) >= 224;
  return h === "::" || /^fe[89ab][0-9a-f]?:/.test(h) || /^ff/.test(h) || h.startsWith("::ffff:");
}

/** Yerel AI adresi: yalnızca özel ağ / loopback; http yalnızca yerel ağ test yapısında. */
export function validateLocalAiUrl(url: string, lanTest: boolean): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error("URL_INVALID");
  }
  if (u.username || u.password || u.hash) throw new Error("URL_INVALID");
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("URL_SCHEME");
  if (isForbiddenHost(u.hostname)) throw new Error("TARGET_FORBIDDEN");
  if (!isPrivateHost(u.hostname)) throw new Error("TARGET_NOT_ALLOWED");
  if (u.protocol === "http:" && !lanTest) throw new Error("CLEARTEXT_BLOCKED");
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}
