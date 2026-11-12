/**
 * Telefon simülatörü (YALNIZCA TEST). Android uygulamasının yapacağı protokol adımlarını TypeScript ile
 * taklit eder. Böylece ajan ve relay, gerçek telefon gelmeden önce uçtan uca sınanabilir.
 * Gerçek Android davranışını (Keystore, biyometri, StrongBox) TAKLİT ETMEZ: anahtarlar bellektedir.
 */
import {
  concat,
  fromB64,
  fromUtf8,
  generateDhKeyPair,
  generateSigningKeyPair,
  openPairingMessage,
  sealPairingMessage,
  toB64,
  utf8,
  verify,
  type DhKeyPair,
  type SigningKeyPair,
} from "@saklaz/crypto";
import {
  buildHeader,
  canonicalBytes,
  cosignRosterEntry,
  decodeInnerMessage,
  E2EChannel,
  encodeInnerMessage,
  ROSTER_GENESIS_PREV,
  RosterLog,
  signInnerMessage,
  signRosterEntry,
  verifyInnerMessageSignature,
  type Body,
  type InnerMessage,
  type MessageType,
  type RosterDevice,
  type RosterEntry,
  type WireKind,
  type WireOut,
} from "@saklaz/protocol";

export interface QrPayload {
  agentId: string;
  signPub: string;
  dhPub: string;
  secret: string;
  sessionId: string;
  expiresAt: number;
}

export class PhoneSim {
  readonly sign: SigningKeyPair = generateSigningKeyPair();
  readonly approval: SigningKeyPair = generateSigningKeyPair();
  readonly dh: DhKeyPair = generateDhKeyPair();
  roster = new RosterLog();
  channel: E2EChannel | undefined;
  private ctr = 0;
  private pendingPair: { qr: QrPayload; addEntry: RosterEntry } | undefined;
  /** Doğrulanmış, ajandan gelen mesajlar. */
  readonly inbox: InnerMessage[] = [];
  /** Çözülemeyen veya doğrulanamayan çerçeveler (teşhis için). */
  readonly errors: string[] = [];

  constructor(
    readonly id: string,
    readonly ws: string,
    private readonly now: () => number = Date.now,
  ) {}

  device(owner = true): RosterDevice {
    return {
      kind: "phone",
      deviceId: this.id,
      label: "Test telefonu",
      signPub: toB64(this.sign.publicKey),
      approvalPub: toB64(this.approval.publicKey),
      dhPub: toB64(this.dh.publicKey),
      owner,
    };
  }

  /** İlk kurulum: telefon alanın sahibi olarak genesis girişini imzalar. */
  createWorkspace(): RosterEntry {
    const g = signRosterEntry(
      {
        ws: this.ws,
        seq: 0,
        prev: ROSTER_GENESIS_PREV,
        ts: this.now(),
        op: "genesis",
        body: { device: this.device(true), recoveryPub: null, policy: { recoveryDelayHours: 72 } },
        signer: this.id,
      },
      this.approval.secretKey,
    );
    this.roster.appendOne(g);
    this.ensureChannel();
    return g;
  }

  private ensureChannel(): void {
    this.channel ??= new E2EChannel({
      ws: this.ws,
      selfId: this.id,
      selfDh: this.dh,
      now: this.now,
      peerDhPub: (pid) => {
        const d = this.roster.current.devices.get(pid);
        return d && !d.revoked ? fromB64(d.dhPub) : undefined;
      },
    });
  }

  /** Sahip olarak yeni bir liste girişi imzalar ve kendi listesine ekler. */
  ownerEntry(op: "device.revoke" | "link.set" | "link.remove", body: unknown): RosterEntry {
    const h = this.roster.head();
    const e = signRosterEntry({ ws: this.ws, seq: h.seq + 1, prev: h.hash, ts: this.now(), op, body, signer: this.id }, this.approval.secretKey);
    this.roster.appendOne(e);
    return e;
  }

  /**
   * Yeni cihazı ekler: sahip imzalar, eklenen cihaz eş-imzalar (anahtar sahipliği kanıtı), sonra listeye girer.
   * Gerçek uygulamada eş-imza QR eşleştirmesi sırasında yeni cihazdan gelir.
   */
  ownerAdd(device: RosterDevice, cosignerSecret: Uint8Array): RosterEntry {
    const h = this.roster.head();
    const e = cosignRosterEntry(
      signRosterEntry({ ws: this.ws, seq: h.seq + 1, prev: h.hash, ts: this.now(), op: "device.add", body: { device }, signer: this.id }, this.approval.secretKey),
      cosignerSecret,
    );
    this.roster.appendOne(e);
    return e;
  }

  /** Başka bir telefonun (ör. yedek cihaz) listeyi bu telefonunkiyle eşitlemesi. */
  syncRosterFrom(other: PhoneSim): void {
    this.roster = RosterLog.fromEntries(other.roster.all());
  }

  /** QR okundu: bilgisayarı ekleyen girişi hazırlar ve S ile şifrelenmiş eşleştirme isteğini üretir. */
  scanQr(qr: QrPayload, agentLabel = "Bilgisayar"): WireOut {
    const h = this.roster.head();
    const device: RosterDevice = { kind: "computer", deviceId: qr.agentId, label: agentLabel, signPub: qr.signPub, dhPub: qr.dhPub };
    const addEntry = signRosterEntry(
      { ws: this.ws, seq: h.seq + 1, prev: h.hash, ts: this.now(), op: "device.add", body: { device }, signer: this.id },
      this.approval.secretKey,
    );
    this.pendingPair = { qr, addEntry };
    const payload = { phoneId: this.id, ws: this.ws, entries: this.roster.all(), addEntry };
    const box = sealPairingMessage(fromB64(qr.secret), "pair-req", qr.sessionId, utf8(JSON.stringify(payload)));
    return { to: qr.agentId, kind: "pair", ct: toB64(concat(box.nonce, box.ciphertext)) };
  }

  /** Bilgisayardan "pair-ok" gelince: ajan imzasını doğrula, eş-imzalı girişi ekle, bağı kur. */
  completePairing(ct: string, role: "owner" | "operator" | "viewer" = "owner"): RosterEntry[] {
    const p = this.pendingPair;
    if (!p) throw new Error("bekleyen eşleştirme yok");
    this.pendingPair = undefined;
    const raw = fromB64(ct);
    const plain = openPairingMessage(fromB64(p.qr.secret), "pair-ok", p.qr.sessionId, { nonce: raw.subarray(0, 24), ciphertext: raw.subarray(24) });
    const { entry, agentSig } = JSON.parse(fromUtf8(plain)) as { entry: RosterEntry; agentSig: string };
    this.roster.appendOne(entry);
    const transcript = canonicalBytes({ ws: this.ws, agentId: p.qr.agentId, phoneId: this.id, head: this.roster.head() });
    if (!verify("SAKLAZ-v1/pair", transcript, fromB64(agentSig), fromB64(p.qr.signPub))) throw new Error("ajan imzası geçersiz");
    const link = this.ownerEntry("link.set", { phoneId: this.id, computerId: p.qr.agentId, role });
    return [link];
  }

  /** İmzalı ve şifreli mesaj. */
  send<T extends MessageType>(to: string, type: T, body: Body<T>, opts: { lifetimeMs?: number; ts?: number } = {}): WireOut[] {
    this.ensureChannel();
    const hdr = buildHeader({
      type,
      ws: this.ws,
      rh: this.roster.head(),
      from: this.id,
      to,
      ctr: ++this.ctr,
      ts: opts.ts ?? this.now(),
      ...(opts.lifetimeMs !== undefined ? { lifetimeMs: opts.lifetimeMs } : {}),
    });
    const msg = signInnerMessage(hdr, body, this.sign);
    if (!this.channel) throw new Error("kanal yok");
    return this.channel.send(to, encodeInnerMessage(msg));
  }

  /** Ajandan gelen çerçeveleri çözer ve ajan imzasını listeden doğrular. */
  receive(frames: { from: string; kind: WireKind | "pair"; ct: string }[]): WireOut[] {
    this.ensureChannel();
    const out: WireOut[] = [];
    for (const f of frames) {
      if (f.kind === "pair" || !this.channel) continue;
      let r;
      try {
        r = this.channel.receive(f.from, f.kind, f.ct);
      } catch (e) {
        // Gerçek uygulama gibi: çözülemeyen tek çerçeve kaydedilir, grubun geri kalanı işlenir.
        this.errors.push(e instanceof Error ? e.message : String(e));
        continue;
      }
      out.push(...r.replies);
      if (r.plaintext) {
        const msg = decodeInnerMessage(r.plaintext);
        const d = this.roster.current.devices.get(msg.hdr.from);
        if (!d || d.revoked) throw new Error("bilinmeyen ajan");
        verifyInnerMessageSignature(msg, fromB64(d.signPub));
        this.inbox.push(msg);
      }
    }
    return out;
  }
}

/** Ajandan gelen çerçeveleri telefona, telefonunkileri ajana aktaran basit "sahte relay" yardımcıları. */
export function toFrames(from: string, outs: WireOut[]): { from: string; kind: WireKind | "pair"; ct: string }[] {
  return outs.map((o) => ({ from, kind: o.kind, ct: o.ct }));
}

export { verify };
