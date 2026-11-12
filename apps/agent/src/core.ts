/**
 * Ajan çekirdeği — gelen mesajların işlenmesi, eşleştirme, cihaz listesi, acil kilit, iptal.
 *
 * Sprint 2 kapsamı: güvenlik çekirdeği.
 * `cmd.create` komutları doğrulanır, denetim kaydına yazılır ve teslim onayı (ack) ile "alındı" olayı
 * döndürülür. Komutların ÇALIŞTIRILMASI (orkestratör, araçlar) Sprint 3'tedir.
 */
import {
  computeSas,
  fromB64,
  generateDhKeyPair,
  generatePairingSecret,
  generateSigningKeyPair,
  openPairingMessage,
  randomBytes,
  sealPairingMessage,
  signingKeyPairFromSeed,
  dhKeyPairFromSecret,
  sign,
  concat,
  toB64,
  utf8,
  fromUtf8,
  type DhKeyPair,
  type SigningKeyPair,
} from "@saklaz/crypto";
import {
  ApprovalLedger,
  buildHeader,
  canonicalBytes,
  cosignRosterEntry,
  decodeInnerMessage,
  E2EChannel,
  E2EError,
  encodeInnerMessage,
  IncomingVerifier,
  ProtocolError,
  RosterError,
  RosterLog,
  signInnerMessage,
  type Body,
  type InnerMessage,
  type MessageType,
  type RosterDevice,
  type RosterEntry,
  type WireKind,
  type WireOut,
} from "@saklaz/protocol";
import { AuditLog } from "./audit.js";
import { getMeta, openAgentDb, setMeta, type AgentDb } from "./db.js";
import { Lockdown, type LocalAuthenticator } from "./lockdown.js";
import { RollbackGuard, type RollbackStatus } from "./rollback.js";
import { loadRoster, persistRosterEntry, SqliteApprovalStore, SqliteReplayStore } from "./stores.js";
import type { SecretVault } from "./vault.js";

export interface AgentOptions {
  dbPath: string;
  vault: SecretVault;
  now?: () => number;
  /** Acil kilit devreye girdiğinde bağlantı katmanının bağlantıyı kesmesi için. */
  onLockdown?: () => void;
  label?: string;
}

export interface IncomingFrame {
  from: string;
  kind: WireKind | "pair";
  ct: string;
}

export interface ProcessResult {
  out: WireOut[];
  accepted: InnerMessage[];
  rejected: { from: string; code: string }[];
}

interface PendingPairing {
  sessionId: string;
  secret: Uint8Array;
  expiresAt: number;
  phone?: {
    phoneId: string;
    ws: string;
    entries: unknown[];
    addEntry: RosterEntry;
    sas: string;
  };
}

const SIGN_SEED = "agent-sign-seed";
const DH_SECRET = "agent-dh-secret";

export class AgentCore {
  readonly db: AgentDb;
  readonly audit: AuditLog;
  readonly lockdown: Lockdown;
  readonly rollback: RollbackGuard;
  readonly startup: RollbackStatus;
  readonly deviceId: string;
  readonly sign: SigningKeyPair;
  readonly dh: DhKeyPair;
  private roster: RosterLog | undefined;
  private verifier: IncomingVerifier | undefined;
  private channel: E2EChannel | undefined;
  private ledger: ApprovalLedger | undefined;
  private pairing: PendingPairing | undefined;
  private readonly now: () => number;

  constructor(private readonly o: AgentOptions) {
    this.now = o.now ?? Date.now;
    this.db = openAgentDb(o.dbPath, o.vault);
    this.audit = new AuditLog(this.db);
    this.lockdown = new Lockdown(this.db);
    this.rollback = new RollbackGuard(this.db, o.vault);
    this.startup = this.rollback.checkOnStartup(this.now());

    // Kimlik: anahtarlar kasada, cihaz kimliği veritabanında.
    let seed = o.vault.get(SIGN_SEED);
    if (!seed) {
      seed = randomBytes(32);
      o.vault.set(SIGN_SEED, seed);
    }
    this.sign = signingKeyPairFromSeed(seed);
    let dhs = o.vault.get(DH_SECRET);
    if (!dhs) {
      dhs = generateDhKeyPair().secretKey;
      o.vault.set(DH_SECRET, dhs);
    }
    this.dh = dhKeyPairFromSecret(dhs);
    let id = getMeta(this.db, "device_id");
    if (!id) {
      id = `dev_${toB64(randomBytes(16))}`;
      setMeta(this.db, "device_id", id);
    }
    this.deviceId = id;

    this.audit.append("agent.start", { vault: o.vault.kind, locked: this.lockdown.locked }, this.now());
    if (this.startup.restoreDetected) {
      this.audit.append(
        "restore.detected",
        { dbEpoch: this.startup.dbEpoch, vaultEpoch: this.startup.vaultEpoch, floor: this.startup.restoreFloorMs ?? 0 },
        this.now(),
      );
    }

    const roster = loadRoster(this.db);
    if (roster) this.activate(roster);
  }

  get workspaceId(): string | undefined {
    return getMeta(this.db, "ws");
  }

  get rosterHead() {
    return this.roster?.head();
  }

  get rosterLog(): RosterLog | undefined {
    return this.roster;
  }

  descriptor(): RosterDevice {
    return {
      kind: "computer",
      deviceId: this.deviceId,
      label: this.o.label ?? "Bilgisayar",
      signPub: toB64(this.sign.publicKey),
      dhPub: toB64(this.dh.publicKey),
    };
  }

  private activate(roster: RosterLog): void {
    const ws = this.workspaceId;
    if (!ws) throw new Error("Çalışma alanı kimliği yok.");
    this.roster = roster;
    const replay = new SqliteReplayStore(this.db, () => {
      this.rollback.bump();
    });
    this.verifier = new IncomingVerifier(ws, this.deviceId, roster, replay);
    this.ledger = new ApprovalLedger(new SqliteApprovalStore(this.db), ws, this.deviceId);
    this.channel = new E2EChannel({
      ws,
      selfId: this.deviceId,
      selfDh: this.dh,
      now: this.now,
      peerDhPub: (id) => {
        const d = this.roster?.current.devices.get(id);
        return d && !d.revoked && !this.isLocallyDenied(id) ? fromB64(d.dhPub) : undefined;
      },
    });
  }

  get approvals(): ApprovalLedger | undefined {
    return this.ledger;
  }

  // ---- Yerel güvenlik eylemleri ----------------------------------------------------------------

  /** Yerel acil kilit (masaüstü düğmesi / kısayol). Sunucudan bağımsızdır. */
  engageLocalLockdown(reason: string): void {
    this.engageLockdown("local", reason);
  }

  private engageLockdown(source: string, reason: string): void {
    if (this.lockdown.locked) return;
    this.lockdown.engage(source, reason, this.now());
    this.channel?.dropAll();
    this.audit.append("lockdown.engaged", { source, reason }, this.now());
    this.o.onLockdown?.();
  }

  async releaseLockdown(auth: LocalAuthenticator): Promise<boolean> {
    const ok = await this.lockdown.release(auth);
    this.audit.append(ok ? "lockdown.released" : "lockdown.release_denied", {}, this.now());
    return ok;
  }

  /**
   * Yerel iptal: bu bilgisayar belirtilen cihazdan gelen her şeyi reddeder. Sunucudan ve cihaz
   * listesinden bağımsızdır. Listedeki kalıcı iptali yine bir sahip telefon imzalamalıdır.
   */
  localDeny(deviceId: string, reason: string): void {
    this.db
      .prepare("INSERT INTO local_deny (device_id, reason, ts) VALUES (?, ?, ?) ON CONFLICT(device_id) DO NOTHING")
      .run(deviceId, reason, this.now());
    this.channel?.dropPeer(deviceId);
    this.audit.append("device.local_deny", { deviceId, reason }, this.now());
  }

  isLocallyDenied(deviceId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM local_deny WHERE device_id = ?").get(deviceId);
  }

  private isLocked(): boolean {
    return this.lockdown.locked;
  }

  // ---- Gelen mesajlar ---------------------------------------------------------------------------

  /**
   * Bir grup gelen çerçeveyi işler. Kuyruktan toplu gelen mesajlarda, geçerli bir acil kilit
   * mesajı varsa önce o uygulanır ve geri kalanların hiçbiri işlenmez (S21).
   */
  processIncoming(frames: IncomingFrame[]): ProcessResult {
    const res: ProcessResult = { out: [], accepted: [], rejected: [] };
    if (this.lockdown.locked) {
      for (const f of frames) this.reject(res, f.from, "LOCKED");
      return res;
    }
    // 1) Uçtan uca şifreyi çöz
    const inner: { from: string; bytes: Uint8Array }[] = [];
    for (const f of frames) {
      if (f.kind === "pair") {
        this.handlePairFrame(f, res);
        continue;
      }
      if (!this.channel) {
        this.reject(res, f.from, "NOT_PAIRED");
        continue;
      }
      if (this.isLocallyDenied(f.from)) {
        this.reject(res, f.from, "LOCAL_DENY");
        continue;
      }
      try {
        const r = this.channel.receive(f.from, f.kind, f.ct);
        res.out.push(...r.replies);
        if (r.plaintext) inner.push({ from: f.from, bytes: r.plaintext });
      } catch (e) {
        this.reject(res, f.from, e instanceof E2EError ? e.code : "E2E_ERROR");
      }
    }
    // 2) Acil kilit önce: toplu teslimdeki geçerli kilit mesajlarını diğerlerinden önce doğrula
    const isLockdown = (b: Uint8Array) => {
      try {
        return decodeInnerMessage(b).hdr.type === "agent.lockdown";
      } catch {
        return false;
      }
    };
    const ordered = [...inner.filter((m) => isLockdown(m.bytes)), ...inner.filter((m) => !isLockdown(m.bytes))];
    for (const m of ordered) {
      // Döngü içinde kilit devreye girebilir (kilit mesajı önce işlenir); bu yüzden her adımda yeniden okunur.
      if (this.isLocked()) {
        this.reject(res, m.from, "LOCKED");
        continue;
      }
      this.handleInner(m.from, m.bytes, res);
    }
    return res;
  }

  private reject(res: ProcessResult, from: string, code: string): void {
    res.rejected.push({ from, code });
    this.audit.append("msg.rejected", { from, code }, this.now());
  }

  private handleInner(from: string, bytes: Uint8Array, res: ProcessResult): void {
    if (!this.verifier || !this.roster) {
      this.reject(res, from, "NOT_PAIRED");
      return;
    }
    let v;
    try {
      // Zarfın göndereni ile imzalı başlıktaki gönderen aynı olmalı.
      const hdrFrom = decodeInnerMessage(bytes).hdr.from;
      if (hdrFrom !== from) {
        this.reject(res, from, "SENDER_MISMATCH");
        return;
      }
      v = this.verifier.verify(bytes, this.now(), this.rollback.restoreFloorMs !== undefined ? { restoreFloorMs: this.rollback.restoreFloorMs } : {});
    } catch (e) {
      if (e instanceof ProtocolError) {
        this.reject(res, from, e.code);
        if (e.code === "ROSTER_BEHIND") {
          // Eksik liste girişlerini iste (imzalı).
          res.out.push(...this.sendTo(from, "roster.need", { fromSeq: this.roster.head().seq + 1 }));
        }
        return;
      }
      throw e;
    }
    const { msg } = v;
    if (v.verdict === "duplicate") {
      this.audit.append("msg.duplicate", { from, type: msg.hdr.type, msgId: msg.hdr.msgId }, this.now());
      res.out.push(...this.sendTo(from, "ack", { ackOf: msg.hdr.msgId, status: "duplicate", code: "DUPLICATE" }));
      return;
    }
    this.audit.append("msg.accepted", { from, type: msg.hdr.type, msgId: msg.hdr.msgId }, this.now());
    res.accepted.push(msg);

    switch (msg.hdr.type) {
      case "agent.lockdown": {
        res.out.push(...this.sendTo(from, "ack", { ackOf: msg.hdr.msgId, status: "accepted", code: "OK" }));
        this.engageLockdown(`phone:${from}`, (msg.body as Body<"agent.lockdown">).reason ?? "");
        return;
      }
      case "roster.append": {
        const entries = (msg.body as Body<"roster.append">).entries;
        let code: "OK" | "REJECTED" = "OK";
        for (const e of entries) {
          try {
            if (this.roster.appendOne(e) === "appended") {
              persistRosterEntry(this.db, e as unknown as RosterEntry);
              this.audit.append("roster.appended", { seq: (e as { seq: number }).seq, op: (e as { op: string }).op }, this.now());
            }
          } catch (err) {
            if (!(err instanceof RosterError)) throw err;
            code = "REJECTED";
            this.audit.append(err.code === "ROSTER_FORK" ? "roster.forked" : "roster.rejected", { code: err.code }, this.now());
            break;
          }
        }
        // İptal edilen cihazların oturum anahtarlarını bellekten at.
        for (const id of this.roster.current.revokedIds) this.channel?.dropPeer(id);
        res.out.push(
          ...this.sendTo(from, "ack", { ackOf: msg.hdr.msgId, status: code === "OK" ? "accepted" : "rejected", code }),
        );
        return;
      }
      case "cmd.create": {
        // Sprint 2: komut doğrulandı ve kaydedildi; çalıştırma Sprint 3'te.
        res.out.push(...this.sendTo(from, "ack", { ackOf: msg.hdr.msgId, status: "accepted", code: "OK" }));
        const b = msg.body as Body<"cmd.create">;
        res.out.push(...this.sendTo(from, "task.event", { taskId: b.taskId, seq: 0, status: "received" }));
        return;
      }
      default:
        res.out.push(...this.sendTo(from, "ack", { ackOf: msg.hdr.msgId, status: "accepted", code: "OK" }));
    }
  }

  /** Ajandan telefona imzalı ve uçtan uca şifreli mesaj. */
  sendTo<T extends MessageType>(to: string, type: T, body: Body<T>): WireOut[] {
    if (!this.channel || !this.roster) return [];
    const ws = this.workspaceId ?? "";
    const key = `out_ctr:${to}`;
    const ctr = Number(getMeta(this.db, key) ?? "0") + 1;
    setMeta(this.db, key, String(ctr));
    const hdr = buildHeader({ type, ws, rh: this.roster.head(), from: this.deviceId, to, ctr, ts: this.now() });
    const msg = signInnerMessage(hdr, body, this.sign);
    return this.channel.send(to, encodeInnerMessage(msg));
  }

  // ---- Eşleştirme (bilgisayar tarafı) -----------------------------------------------------------

  /** Ekranda gösterilecek QR içeriğini üretir. Eşleştirme sırrı relay'e hiç gönderilmez. */
  startPairing(): { agentId: string; signPub: string; dhPub: string; secret: string; sessionId: string; expiresAt: number } {
    const secret = generatePairingSecret();
    const sessionId = toB64(randomBytes(12));
    const expiresAt = this.now() + 5 * 60_000;
    this.pairing = { sessionId, secret, expiresAt };
    this.audit.append("pairing.started", { sessionId }, this.now());
    return { agentId: this.deviceId, signPub: toB64(this.sign.publicKey), dhPub: toB64(this.dh.publicKey), secret: toB64(secret), sessionId, expiresAt };
  }

  private handlePairFrame(f: IncomingFrame, res: ProcessResult): void {
    const p = this.pairing;
    if (!p || this.now() > p.expiresAt || p.phone) {
      this.reject(res, f.from, "NO_PAIRING");
      return;
    }
    try {
      const raw = fromB64(f.ct);
      const plain = openPairingMessage(p.secret, "pair-req", p.sessionId, { nonce: raw.subarray(0, 24), ciphertext: raw.subarray(24) });
      const req = JSON.parse(fromUtf8(plain)) as { phoneId: string; ws: string; entries: unknown[]; addEntry: RosterEntry };
      if (req.phoneId !== f.from) throw new Error("gönderen uyuşmuyor");
      // Telefonun listesini doğrula ve bu bilgisayarın ekleme girişinin gerçekten BU cihazı eklediğini denetle.
      const log = RosterLog.fromEntries(req.entries);
      if (log.current.ws !== req.ws) throw new Error("alan uyuşmuyor");
      // Yalnızca güvenlikle ilgili alanlar karşılaştırılır (tür, kimlik, anahtarlar). Görünen ad (label)
      // kullanıcının telefonda verdiği bir isimdir; şema düzeyinde kontrol karakterlerine karşı süzülür.
      const added = (req.addEntry.body as { device?: RosterDevice }).device;
      const me = this.descriptor();
      if (
        req.addEntry.op !== "device.add" ||
        added?.kind !== "computer" ||
        added.deviceId !== me.deviceId ||
        added.signPub !== me.signPub ||
        added.dhPub !== me.dhPub
      ) {
        throw new Error("ekleme girişi bu cihazı tanımlamıyor");
      }
      const phone = log.current.devices.get(req.phoneId);
      if (!phone || phone.kind !== "phone" || !phone.owner || phone.revoked) throw new Error("telefon sahip değil");
      const sas = computeSas({
        secret: p.secret,
        agentSignPub: this.sign.publicKey,
        agentDhPub: this.dh.publicKey,
        phoneSignPub: fromB64(phone.signPub),
        phoneDhPub: fromB64(phone.dhPub),
      });
      p.phone = { phoneId: req.phoneId, ws: req.ws, entries: req.entries, addEntry: req.addEntry, sas };
    } catch {
      this.pairing = undefined; // tek deneme: hatalı istek oturumu kapatır
      this.audit.append("pairing.failed", { from: f.from }, this.now());
      this.reject(res, f.from, "PAIRING_INVALID");
    }
  }

  /** Bilgisayar ekranında gösterilecek SAS (telefon isteği geldikten sonra). */
  pairingSas(): string | undefined {
    return this.pairing?.phone?.sas;
  }

  /**
   * Kullanıcı iki ekrandaki SAS'ın aynı olduğunu YEREL olarak onayladığında çağrılır.
   * Bilgisayar ekleme girişini eş-imzalar, listeyi kurar ve telefona şifreli "pair-ok" gönderir.
   */
  confirmPairing(sasMatches: boolean): WireOut | undefined {
    const p = this.pairing;
    this.pairing = undefined;
    if (!p?.phone || !sasMatches || this.now() > p.expiresAt) {
      this.audit.append("pairing.failed", { reason: sasMatches ? "expired" : "sas_mismatch" }, this.now());
      return undefined;
    }
    const cosigned = cosignRosterEntry(p.phone.addEntry, this.sign.secretKey);
    const log = RosterLog.fromEntries(p.phone.entries);
    log.appendOne(cosigned);
    const tx = this.db.transaction(() => {
      setMeta(this.db, "ws", p.phone?.ws ?? "");
      this.db.prepare("DELETE FROM roster").run();
      for (const e of log.all()) persistRosterEntry(this.db, e);
    });
    tx();
    this.activate(log);
    const transcript = canonicalBytes({ ws: p.phone.ws, agentId: this.deviceId, phoneId: p.phone.phoneId, head: log.head() });
    const agentSig = toB64(sign("SAKLAZ-v1/pair", transcript, this.sign.secretKey));
    const box = sealPairingMessage(p.secret, "pair-ok", p.sessionId, utf8(JSON.stringify({ entry: cosigned, agentSig })));
    this.audit.append("pairing.completed", { phoneId: p.phone.phoneId, ws: p.phone.ws, head: log.head().seq }, this.now());
    return { to: p.phone.phoneId, kind: "pair", ct: toB64(concat(box.nonce, box.ciphertext)) };
  }

  close(): void {
    this.channel?.dropAll();
    this.db.close();
  }
}

/** Testler ve telefon simülasyonu için: yeni cihaz anahtarları. */
export function newDeviceKeys() {
  return { sign: generateSigningKeyPair(), dh: generateDhKeyPair() };
}
