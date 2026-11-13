/**
 * Eşleştirme kodu: bilgisayar ekranında QR olarak gösterilir (bant dışı kanal). Eşleştirme sırrı
 * yalnızca bu kodda bulunur; relay'e hiç gönderilmez. Kamera kullanılamazsa aynı metin elle de girilebilir.
 *
 *   SAKLAZ1:<base64url(JSON)>
 */
import { fromB64, fromUtf8, toB64, utf8 } from "@saklaz/crypto";

export interface PairingQr {
  agentId: string;
  signPub: string;
  dhPub: string;
  secret: string;
  sessionId: string;
  expiresAt: number;
  /** Ajanın bağlandığı relay (bilgi amaçlı; telefon kendi profilindeki relay'i kullanır). */
  relay?: string;
}

const PREFIX = "SAKLAZ1:";
const B64 = /^[A-Za-z0-9_-]+$/;

export function encodePairingQr(q: PairingQr): string {
  return PREFIX + toB64(utf8(JSON.stringify(q)));
}

export function decodePairingQr(text: string): PairingQr {
  const t = text.trim();
  if (!t.startsWith(PREFIX) || t.length > 2048) throw new Error("QR_INVALID");
  let o: unknown;
  try {
    o = JSON.parse(fromUtf8(fromB64(t.slice(PREFIX.length))));
  } catch {
    throw new Error("QR_INVALID");
  }
  const q = o as Record<string, unknown>;
  const s = (k: string, re: RegExp, max: number) => typeof q[k] === "string" && q[k].length <= max && re.test(q[k]);
  if (
    !s("agentId", /^dev_[A-Za-z0-9_-]{16,64}$/, 70) ||
    !s("signPub", B64, 64) ||
    !s("dhPub", B64, 64) ||
    !s("secret", B64, 64) ||
    !s("sessionId", B64, 64) ||
    typeof q["expiresAt"] !== "number" ||
    (q["relay"] !== undefined && !s("relay", /^wss?:\/\/[^\s]{3,200}$/, 210))
  ) {
    throw new Error("QR_INVALID");
  }
  if (fromB64(q["signPub"] as string).length !== 32 || fromB64(q["dhPub"] as string).length !== 32 || fromB64(q["secret"] as string).length !== 32) {
    throw new Error("QR_INVALID");
  }
  return q as unknown as PairingQr;
}
