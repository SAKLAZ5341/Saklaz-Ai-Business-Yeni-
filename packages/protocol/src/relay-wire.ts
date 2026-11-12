/**
 * Cihaz ↔ relay tel protokolü (WSS üzerinde JSON metin çerçeveleri).
 *
 * Relay bu çerçevelerin İÇİNDEKİ `ct` alanını çözemez. `ct`, E2EChannel'ın ürettiği uçtan uca
 * şifreli veridir. Relay yalnızca yönlendirme meta verisini görür: kimden, kime, tür, boyut, zaman.
 *
 * Kimlik doğrulama iki katmanlıdır:
 *   1. Hesap erişim token'ı (parola + TOTP ile alınır) — relay'e bağlanma yetkisi.
 *   2. Cihaz anahtarıyla meydan okuma imzası (SAKLAZ-v1/relay-auth) — çalınmış bir token tek başına yetmez.
 * Bu iki katmanın hiçbiri ajana komut yetkisi VERMEZ; komut yetkisi imzalı mesajlardan gelir.
 */
import { z } from "zod";
import { B64_32, B64_64, DeviceId, Uuid } from "./schemas.js";

const Ct = z.string().regex(/^[A-Za-z0-9_-]{1,350000}$/);
export const WIRE_KINDS = ["sealed", "hs1", "hs2", "noise", "pair"] as const;

export const ClientFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("auth"), deviceId: DeviceId, token: z.string().min(10).max(4096) }),
  z.strictObject({ t: z.literal("auth.proof"), sig: B64_64 }),
  z.strictObject({
    t: z.literal("send"),
    id: Uuid,
    to: DeviceId,
    kind: z.enum(WIRE_KINDS),
    /** Kuyrukta bekleme süresi; relay en çok 72 saat uygular. */
    ttlSec: z.number().int().min(1).max(72 * 3600),
    ct: Ct,
  }),
  z.strictObject({ t: z.literal("delivered"), id: Uuid }),
  z.strictObject({ t: z.literal("presence.query"), deviceIds: z.array(DeviceId).max(100) }),
  z.strictObject({ t: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export const ServerFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("challenge"), nonce: B64_32, relayId: z.string().min(1).max(128) }),
  z.strictObject({ t: z.literal("ready"), deviceId: DeviceId, queued: z.number().int().min(0) }),
  z.strictObject({ t: z.literal("accepted"), id: Uuid }),
  z.strictObject({
    t: z.literal("deliver"),
    id: Uuid,
    from: DeviceId,
    kind: z.enum(WIRE_KINDS),
    ct: Ct,
    sentAt: z.number().int(),
  }),
  z.strictObject({
    t: z.literal("presence"),
    items: z.array(z.strictObject({ deviceId: DeviceId, online: z.boolean(), lastSeen: z.number().int().nullable() })),
  }),
  z.strictObject({ t: z.literal("error"), id: Uuid.optional(), code: z.string().regex(/^[A-Z_]{2,64}$/) }),
  z.strictObject({ t: z.literal("pong") }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/** Relay meydan okumasına verilen imzanın kapsadığı baytlar. */
export function relayAuthPayload(deviceId: string, nonce: string, relayId: string): { deviceId: string; nonce: string; relayId: string } {
  return { deviceId, nonce, relayId };
}
