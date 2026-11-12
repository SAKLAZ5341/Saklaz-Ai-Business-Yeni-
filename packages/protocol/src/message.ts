/**
 * İmzalı iç mesajlar (FAZ1-PLAN §4).
 *
 *   sig = Ed25519(gönderen, "SAKLAZ-v1/msg" || 0x00 || JCS(hdr) || 0x00 || JCS(body))
 *
 * JCS çıktısı hiçbir zaman ham 0x00 baytı içermez (kontrol karakterleri kaçışlıdır); bu yüzden
 * ayraç belirsizlik yaratmaz.
 */
import {
  concat,
  fromB64,
  randomBytes,
  sign,
  toB64,
  verify,
  type SigningKeyPair,
} from "@saklaz/crypto";
import { canonicalBytes } from "./jcs.js";
import { ProtocolError } from "./errors.js";
import {
  BodySchemas,
  HeaderSchema,
  MAX_LIFETIME_MS,
  PROTOCOL_VERSION,
  RawInnerMessageSchema,
  type Body,
  type Header,
  type InnerMessage,
  type MessageType,
} from "./schemas.js";

export function messageSigningBytes(hdr: Header, body: unknown): Uint8Array {
  return concat(canonicalBytes(hdr), new Uint8Array([0]), canonicalBytes(body));
}

/** RFC 9562 UUIDv7: zaman sıralı, rastgele kısmı CSPRNG'den. */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  const ts = BigInt(nowMs);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface HeaderInput<T extends MessageType> {
  type: T;
  /** Çalışma alanı kimliği. */
  ws: string;
  /** Gönderenin bildiği cihaz listesi başı. */
  rh: { seq: number; hash: string };
  from: string;
  to: string;
  ctr: number;
  /** Varsayılan: şimdi. */
  ts?: number;
  /** Ömür (ms). Varsayılan: 5 dk; tipin üst sınırını aşamaz. */
  lifetimeMs?: number;
  msgId?: string;
}

export function buildHeader<T extends MessageType>(i: HeaderInput<T>): Header & { type: T } {
  const ts = i.ts ?? Date.now();
  const lifetime = i.lifetimeMs ?? 5 * 60_000;
  return {
    proto: PROTOCOL_VERSION,
    ws: i.ws,
    rh: { seq: i.rh.seq, hash: i.rh.hash },
    type: i.type,
    msgId: i.msgId ?? uuidv7(ts),
    from: i.from,
    to: i.to,
    ctr: i.ctr,
    ts,
    exp: ts + lifetime,
    nonce: toB64(randomBytes(16)),
  };
}

function validate<T extends MessageType>(hdr: unknown, body: unknown): { hdr: Header & { type: T }; body: Body<T> } {
  const h = HeaderSchema.safeParse(hdr);
  if (!h.success) {
    // Sürüm uyuşmazlığını ayrıca bildir: istemci güncelleme gerektiğini anlayabilsin.
    const proto = (hdr as { proto?: unknown } | null)?.proto;
    if (typeof proto === "string" && proto !== PROTOCOL_VERSION) throw new ProtocolError("UNSUPPORTED_VERSION");
    throw new ProtocolError("SCHEMA_INVALID", "Başlık geçersiz.");
  }
  if (h.data.exp <= h.data.ts) throw new ProtocolError("SCHEMA_INVALID", "exp, ts'den sonra olmalı.");
  if (h.data.exp - h.data.ts > MAX_LIFETIME_MS[h.data.type]) throw new ProtocolError("EXPIRY_TOO_LONG");
  const b = BodySchemas[h.data.type].safeParse(body);
  if (!b.success) throw new ProtocolError("SCHEMA_INVALID", "Gövde geçersiz.");
  return { hdr: h.data as Header & { type: T }, body: b.data as Body<T> };
}

/** Önce şema doğrular, sonra imzalar: geçersiz bir mesaj hiçbir zaman imzalanmaz. */
export function signInnerMessage<T extends MessageType>(
  hdr: Header & { type: T },
  body: Body<T>,
  signer: SigningKeyPair,
): InnerMessage<T> {
  const v = validate<T>(hdr, body);
  const sig = sign("SAKLAZ-v1/msg", messageSigningBytes(v.hdr, v.body), signer.secretKey);
  return { hdr: v.hdr, body: v.body, sig: toB64(sig) };
}

/** Güvenilmez girdiyi (JSON'dan ayrıştırılmış) yapısal olarak doğrular. İmza HENÜZ doğrulanmaz. */
export function parseInnerMessage(raw: unknown): InnerMessage {
  const r = RawInnerMessageSchema.safeParse(raw);
  if (!r.success) throw new ProtocolError("SCHEMA_INVALID", "Mesaj yapısı geçersiz.");
  const v = validate(r.data.hdr, r.data.body);
  return { hdr: v.hdr, body: v.body, sig: r.data.sig };
}

/** İmzayı, eşleştirmede sabitlenmiş açık anahtarla doğrular. */
export function verifyInnerMessageSignature(msg: InnerMessage, senderSignPub: Uint8Array): void {
  const ok = verify("SAKLAZ-v1/msg", messageSigningBytes(msg.hdr, msg.body), fromB64(msg.sig), senderSignPub);
  if (!ok) throw new ProtocolError("SIGNATURE_INVALID");
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
export const MAX_INNER_MESSAGE_BYTES = 256 * 1024;

export function encodeInnerMessage(msg: InnerMessage): Uint8Array {
  return enc.encode(JSON.stringify(msg));
}

/** Boyut sınırı + UTF-8 + JSON + şema. İmza doğrulaması çağıranın sorumluluğundadır (bkz. verifier). */
export function decodeInnerMessage(bytes: Uint8Array): InnerMessage {
  if (bytes.length > MAX_INNER_MESSAGE_BYTES) throw new ProtocolError("SCHEMA_INVALID", "Mesaj çok büyük.");
  let raw: unknown;
  try {
    raw = JSON.parse(dec.decode(bytes)) as unknown;
  } catch {
    throw new ProtocolError("SCHEMA_INVALID", "Mesaj JSON değil.");
  }
  return parseInnerMessage(raw);
}
