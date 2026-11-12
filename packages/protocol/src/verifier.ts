/**
 * Ajandaki gelen mesaj doğrulama hattı — FAZ1-PLAN §4.4 (sıra değiştirilemez).
 *
 *   1. Boyut + UTF-8 + JSON + şema           (decodeInnerMessage)
 *   2. Gönderen eşleştirilmiş mi, iptal edilmiş mi, alıcı bu ajan mı
 *   3. Gönderenin yönü doğru mu (telefon yalnızca telefon→ajan tiplerini gönderebilir)
 *   4. İmza (sabitlenmiş açık anahtar, alan: SAKLAZ-v1/msg)
 *   5. Zaman: gelecekten gelen ve süresi dolmuş mesajlar
 *   6. Rol yetkisi
 *   7. Sayaç (tekrar oynatma) — durum, mesaj işlenmeden ÖNCE kalıcı kaydedilir
 *
 * Bu hattı geçmeyen hiçbir mesaj router'a ulaşmaz. Relay'den gelen kontrol mesajları (ping,
 * presence) bu hatta hiç girmez; ayrı şemadadır ve hiçbir aracı tetikleyemez.
 *
 * Neden rol denetimi sayaçtan önce: yetkisiz bir mesajın sayaç durumunu ilerletmesi istenmez.
 * Neden imza zamandan önce: imzasız bir mesajın içeriğine (zaman alanları dahil) güvenilemez.
 */
import { ProtocolError } from "./errors.js";
import { decodeInnerMessage, verifyInnerMessageSignature } from "./message.js";
import { checkTiming, ReplayGuard, type ReplayStore, type ReplayVerdict } from "./replay.js";
import { PHONE_TO_AGENT_TYPES, type InnerMessage, type MessageType } from "./schemas.js";

export type DeviceRole = "owner" | "operator" | "viewer";

/** FAZ1-PLAN §6.2 — telefon rolüne göre izin verilen mesaj tipleri. */
export const ROLE_PERMISSIONS: Record<DeviceRole, readonly MessageType[]> = {
  owner: [
    "cmd.create",
    "cmd.cancel",
    "approval.decision",
    "history.query",
    "file.request",
    "device.revoke",
    "grant.request",
    "agent.lockdown",
    "ack",
  ],
  // Acil kilit, güvenliği artıran bir eylem olduğu için operator'a da açıktır.
  // Onay kararı varsayılan olarak kapalıdır; politika ile açılabilir (operatorMayApprove).
  operator: ["cmd.create", "cmd.cancel", "history.query", "file.request", "agent.lockdown", "ack"],
  viewer: ["history.query", "ack"],
};

export interface PairedPhone {
  deviceId: string;
  role: DeviceRole;
  /** Komut imza anahtarı (Ed25519). */
  signPub: Uint8Array;
  /** Onay imza anahtarı (Ed25519, her kullanımda biyometrik). */
  approvalSignPub: Uint8Array;
  revoked: boolean;
}

export interface PeerDirectory {
  get(deviceId: string): PairedPhone | undefined;
}

export interface VerifierPolicy {
  operatorMayApprove: boolean;
}

export interface Verified {
  msg: InnerMessage;
  peer: PairedPhone;
  verdict: ReplayVerdict;
}

export class IncomingVerifier {
  private readonly replay: ReplayGuard;

  constructor(
    private readonly agentId: string,
    private readonly peers: PeerDirectory,
    replayStore: ReplayStore,
    private readonly policy: VerifierPolicy = { operatorMayApprove: false },
  ) {
    this.replay = new ReplayGuard(replayStore);
  }

  verify(bytes: Uint8Array, nowMs: number): Verified {
    const msg = decodeInnerMessage(bytes); // 1
    const peer = this.peers.get(msg.hdr.from); // 2
    if (!peer || peer.revoked) throw new ProtocolError("UNKNOWN_SENDER");
    if (msg.hdr.to !== this.agentId) throw new ProtocolError("WRONG_RECIPIENT");
    if (!(PHONE_TO_AGENT_TYPES as readonly string[]).includes(msg.hdr.type)) {
      throw new ProtocolError("ROLE_FORBIDDEN", "Bu mesaj tipi telefondan gönderilemez."); // 3
    }
    verifyInnerMessageSignature(msg, peer.signPub); // 4
    checkTiming(msg.hdr, nowMs); // 5
    const allowed =
      ROLE_PERMISSIONS[peer.role].includes(msg.hdr.type) ||
      (peer.role === "operator" && msg.hdr.type === "approval.decision" && this.policy.operatorMayApprove);
    if (!allowed) throw new ProtocolError("ROLE_FORBIDDEN"); // 6
    const verdict = this.replay.checkAndRecord(peer.deviceId, msg.hdr.ctr); // 7
    return { msg, peer, verdict };
  }
}
