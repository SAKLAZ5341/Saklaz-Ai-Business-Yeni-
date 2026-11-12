/**
 * Ajandaki gelen mesaj doğrulama hattı — FAZ1-PLAN §4.4, v0.3 eklemeleriyle.
 *
 *   1. Boyut + UTF-8 + JSON + şema                      (decodeInnerMessage)
 *   2. Çalışma alanı bu ajanın alanı mı (ws)            — ADR-0013
 *   3. Alıcı bu ajan mı
 *   4. Gönderen imzalı cihaz listesinde, iptal edilmemiş bir telefon mu — ADR-0014
 *   5. Mesaj tipi telefondan gönderilebilir mi
 *   6. İmza (listede sabitlenmiş açık anahtar, alan: SAKLAZ-v1/msg)
 *   7. Zaman: gelecekten gelen, süresi dolmuş ve GERİ YÜKLEME TABANINDAN önceki mesajlar — ADR-0016
 *   8. Cihaz listesi güncelliği (rh): alıcı gerideyse veya çatallanma varsa mesaj işlenmez
 *   9. Rol: telefon ile BU bilgisayar arasındaki bağın rolü (cihazlar arası ayrı güven ilişkisi)
 *  10. Sayaç (tekrar oynatma) — durum, mesaj işlenmeden ÖNCE kalıcı yazılır
 *
 * Bu hattı geçmeyen mesaj router'a iletilmez; bu, testlerle doğrulanan bir tasarım kuralıdır.
 */
import { fromB64 } from "@saklaz/crypto";
import { ProtocolError } from "./errors.js";
import { decodeInnerMessage, verifyInnerMessageSignature } from "./message.js";
import { checkTiming, ReplayGuard, type ReplayStore, type ReplayVerdict } from "./replay.js";
import { linkRole, type LinkRole, type RosterLog } from "./roster.js";
import { PHONE_TO_AGENT_TYPES, type InnerMessage, type MessageType } from "./schemas.js";

export type DeviceRole = LinkRole;

/** FAZ1-PLAN §6.2 — telefon–bilgisayar bağının rolüne göre izin verilen mesaj tipleri. */
export const ROLE_PERMISSIONS: Record<DeviceRole, readonly MessageType[]> = {
  owner: [
    "cmd.create",
    "cmd.cancel",
    "approval.decision",
    "history.query",
    "file.request",
    "roster.append",
    "grant.request",
    "agent.lockdown",
    "ack",
  ],
  // Acil kilit güvenliği artıran bir eylemdir; operator'a da açıktır. Onay varsayılan olarak kapalıdır.
  // roster.append herkes için açıktır çünkü girişlerin geçerliliği gönderene değil, girişlerdeki
  // sahip imzalarına dayanır (roster.ts).
  operator: ["cmd.create", "cmd.cancel", "history.query", "file.request", "roster.append", "agent.lockdown", "ack"],
  viewer: ["history.query", "roster.append", "ack"],
};

export interface VerifierPolicy {
  operatorMayApprove: boolean;
}

export interface VerifyOptions {
  /** Geri yükleme tabanı (ADR-0016): bu andan önceki zaman damgalı mesajlar reddedilir. */
  restoreFloorMs?: number;
}

export interface Verified {
  msg: InnerMessage;
  role: DeviceRole;
  /** Telefonun onay anahtarı (approval.decision doğrulaması için). */
  approvalSignPub: Uint8Array;
  verdict: ReplayVerdict;
}

export class IncomingVerifier {
  private readonly replay: ReplayGuard;

  constructor(
    private readonly workspaceId: string,
    private readonly agentId: string,
    private readonly roster: RosterLog,
    replayStore: ReplayStore,
    private readonly policy: VerifierPolicy = { operatorMayApprove: false },
  ) {
    this.replay = new ReplayGuard(replayStore);
  }

  verify(bytes: Uint8Array, nowMs: number, opts: VerifyOptions = {}): Verified {
    const msg = decodeInnerMessage(bytes); // 1
    if (msg.hdr.ws !== this.workspaceId) throw new ProtocolError("WRONG_WORKSPACE"); // 2
    if (msg.hdr.to !== this.agentId) throw new ProtocolError("WRONG_RECIPIENT"); // 3

    const state = this.roster.current;
    const sender = state.devices.get(msg.hdr.from); // 4
    if (!sender || sender.revoked || sender.kind !== "phone") throw new ProtocolError("UNKNOWN_SENDER");
    if (!(PHONE_TO_AGENT_TYPES as readonly string[]).includes(msg.hdr.type)) {
      throw new ProtocolError("ROLE_FORBIDDEN", "Bu mesaj tipi telefondan gönderilemez."); // 5
    }

    verifyInnerMessageSignature(msg, fromB64(sender.signPub)); // 6

    checkTiming(msg.hdr, nowMs); // 7
    if (opts.restoreFloorMs !== undefined && msg.hdr.ts < opts.restoreFloorMs) {
      throw new ProtocolError("BEFORE_RESTORE_FLOOR");
    }

    // 8 — liste güncelliği. roster.append bu kontrolden muaftır: eksik girişleri getiren mesajın kendisidir.
    if (this.roster.isForked) throw new ProtocolError("ROSTER_FORK");
    const head = this.roster.head();
    if (msg.hdr.type !== "roster.append") {
      if (msg.hdr.rh.seq > head.seq) throw new ProtocolError("ROSTER_BEHIND");
      if (this.roster.hashAt(msg.hdr.rh.seq) !== msg.hdr.rh.hash) throw new ProtocolError("ROSTER_FORK");
    }

    // 9 — rol, bu telefon ile BU bilgisayar arasındaki bağdan
    const role = linkRole(state, sender.deviceId, this.agentId);
    const allowed =
      role !== undefined &&
      (ROLE_PERMISSIONS[role].includes(msg.hdr.type) ||
        (role === "operator" && msg.hdr.type === "approval.decision" && this.policy.operatorMayApprove));
    // Bağı olmayan ama listede kayıtlı bir telefon yalnızca liste girişi iletebilir.
    const rosterOnly = role === undefined && msg.hdr.type === "roster.append";
    if (!allowed && !rosterOnly) throw new ProtocolError("ROLE_FORBIDDEN");

    const verdict = this.replay.checkAndRecord(sender.deviceId, msg.hdr.ctr); // 10
    return { msg, role: role ?? "viewer", approvalSignPub: fromB64(sender.approvalPub), verdict };
  }
}
