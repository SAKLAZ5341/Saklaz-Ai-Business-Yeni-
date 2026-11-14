/**
 * Telefon istemcisi (MVP alfa). Android uygulamasının protokol tarafı.
 *
 * Mantık, ajan ve relay ile uçtan uca sınanmış test simülatörüyle (@saklaz/testkit PhoneSim) aynıdır;
 * fark: anahtarlar ve cihaz listesi kalıcıdır (durum dışa aktarılır, ana uygulama bunu Android
 * Keystore destekli güvenli depoda saklar) ve ajandan gelen mesajlarda tekrar oynatma denetlenir.
 *
 * Kriptografi @saklaz/crypto'dur; bu dosyada yeni kriptografik yapı YOKTUR.
 */
import {
  computeSas,
  concat,
  dhKeyPairFromSecret,
  fromB64,
  fromUtf8,
  generateDhKeyPair,
  openPairingMessage,
  randomBytes,
  sealPairingMessage,
  signingKeyPairFromSeed,
  toB64,
  utf8,
  verify,
  type DhKeyPair,
  type SigningKeyPair,
} from "@saklaz/crypto";
import {
  buildHeader,
  canonicalBytes,
  checkTiming,
  decodeInnerMessage,
  E2EChannel,
  encodeInnerMessage,
  linkRole,
  ReplayGuard,
  ROSTER_GENESIS_PREV,
  RosterLog,
  signInnerMessage,
  signRosterEntry,
  verifyInnerMessageSignature,
  type Body,
  type InnerMessage,
  type MessageType,
  type ReplayState,
  type RosterDevice,
  type RosterEntry,
  type WireKind,
  type WireOut,
} from "@saklaz/protocol";
import { type PairingQr } from "./qr.js";

export interface PhoneState {
  v: 1;
  id: string;
  ws: string;
  label: string;
  /** base64url; 32 baytlık tohumlar / gizli anahtar. GİZLİ: yalnızca güvenli depoda saklanır. */
  signSeed: string;
  approvalSeed: string;
  dhSecret: string;
  entries: RosterEntry[];
  ctr: number;
  /** Ajan başına tekrar oynatma penceresi (protokoldeki kayan pencere; ajanla aynı kural). */
  seen: Record<string, ReplayState>;
}

export interface Computer {
  deviceId: string;
  label: string;
  role: string | undefined;
}

export interface ReceivedFrame {
  from: string;
  kind: WireKind | "pair";
  ct: string;
}

export interface ReceiveOutput {
  replies: WireOut[];
  messages: InnerMessage[];
  /** Çözülemeyen / doğrulanamayan çerçeveler; ayrıntı içermez (yalnızca kod). */
  errors: string[];
}

const WS_RE = /^ws_[A-Za-z0-9_-]{16,64}$/;

export class PhoneClient {
  readonly sign: SigningKeyPair;
  readonly approval: SigningKeyPair;
  readonly dh: DhKeyPair;
  private roster: RosterLog;
  private channel: E2EChannel;
  private pendingPair: { qr: PairingQr; addEntry: RosterEntry } | undefined;
  private readonly replay = new ReplayGuard({
    load: (peer) => this.state.seen[peer],
    save: (peer, st) => {
      this.state.seen[peer] = { highest: st.highest, seen: [...st.seen] };
    },
  });

  private constructor(
    private state: PhoneState,
    private readonly now: () => number,
  ) {
    this.sign = signingKeyPairFromSeed(fromB64(state.signSeed));
    this.approval = signingKeyPairFromSeed(fromB64(state.approvalSeed));
    this.dh = dhKeyPairFromSecret(fromB64(state.dhSecret));
    this.roster = RosterLog.fromEntries(state.entries);
    this.channel = this.newChannel();
  }

  /** Yeni telefon kimliği ve yeni çalışma alanı (bu telefon sahibidir). */
  static createWorkspace(opts: { label?: string; ws?: string; now?: () => number } = {}): PhoneClient {
    const now = opts.now ?? Date.now;
    const ws = opts.ws ?? `ws_${toB64(randomBytes(16))}`;
    if (!WS_RE.test(ws)) throw new Error("WS_INVALID");
    const state: PhoneState = {
      v: 1,
      id: `dev_${toB64(randomBytes(16))}`,
      ws,
      label: (opts.label ?? "Telefon").slice(0, 64),
      signSeed: toB64(randomBytes(32)),
      approvalSeed: toB64(randomBytes(32)),
      dhSecret: toB64(generateDhKeyPair().secretKey),
      entries: [],
      ctr: 0,
      seen: {},
    };
    const c = new PhoneClient(state, now);
    const g = signRosterEntry(
      {
        ws,
        seq: 0,
        prev: ROSTER_GENESIS_PREV,
        ts: now(),
        op: "genesis",
        body: { device: c.selfDevice(), recoveryPub: null, policy: { recoveryDelayHours: 72 } },
        signer: state.id,
      },
      c.approval.secretKey,
    );
    c.roster.appendOne(g);
    c.persistRoster();
    return c;
  }

  /** Güvenli depodan geri yükleme. Liste zinciri baştan doğrulanır. */
  static restore(state: PhoneState, now: () => number = Date.now): PhoneClient {
    if ((state.v as number) !== 1 || !WS_RE.test(state.ws)) throw new Error("STATE_INVALID");
    return new PhoneClient(structuredClone(state), now);
  }

  /** Güvenli depoya yazılacak durum (gizli anahtarlar içerir). */
  exportState(): PhoneState {
    return structuredClone(this.state);
  }

  get id(): string {
    return this.state.id;
  }
  get ws(): string {
    return this.state.ws;
  }
  get rosterHead() {
    return this.roster.head();
  }

  private newChannel(): E2EChannel {
    return new E2EChannel({
      ws: this.state.ws,
      selfId: this.state.id,
      selfDh: this.dh,
      now: this.now,
      peerDhPub: (pid) => {
        const d = this.roster.current.devices.get(pid);
        return d && !d.revoked ? fromB64(d.dhPub) : undefined;
      },
    });
  }

  private persistRoster(): void {
    this.state.entries = [...this.roster.all()];
  }

  selfDevice(): RosterDevice {
    return {
      kind: "phone",
      deviceId: this.state.id,
      label: this.state.label,
      signPub: toB64(this.sign.publicKey),
      approvalPub: toB64(this.approval.publicKey),
      dhPub: toB64(this.dh.publicKey),
      owner: true,
    };
  }

  /** Bu telefona bağlı (iptal edilmemiş) bilgisayarlar. Her biri ayrı kimlik ve anahtara sahiptir. */
  computers(): Computer[] {
    const out: Computer[] = [];
    const cur = this.roster.current;
    for (const d of cur.devices.values()) {
      if (d.kind !== "computer" || d.revoked) continue;
      out.push({ deviceId: d.deviceId, label: d.label, role: linkRole(cur, this.state.id, d.deviceId) });
    }
    return out;
  }

  /** Eşleştirme kodunu (QR) okuduktan sonra: SAS ekranda bilgisayardakiyle karşılaştırılır. */
  sasFor(qr: PairingQr): string {
    return computeSas({
      secret: fromB64(qr.secret),
      agentSignPub: fromB64(qr.signPub),
      agentDhPub: fromB64(qr.dhPub),
      phoneSignPub: this.sign.publicKey,
      phoneDhPub: this.dh.publicKey,
    });
  }

  /** Eşleştirme isteği (eşleştirme sırrıyla şifreli; relay içeriği göremez). */
  startPairing(qr: PairingQr, label: string): WireOut {
    if (qr.expiresAt < this.now()) throw new Error("QR_EXPIRED");
    if (this.roster.current.devices.has(qr.agentId)) throw new Error("ALREADY_PAIRED");
    const h = this.roster.head();
    const device: RosterDevice = { kind: "computer", deviceId: qr.agentId, label: label.slice(0, 64) || "Bilgisayar", signPub: qr.signPub, dhPub: qr.dhPub };
    const addEntry = signRosterEntry(
      { ws: this.state.ws, seq: h.seq + 1, prev: h.hash, ts: this.now(), op: "device.add", body: { device }, signer: this.state.id },
      this.approval.secretKey,
    );
    this.pendingPair = { qr, addEntry };
    const payload = { phoneId: this.state.id, ws: this.state.ws, entries: this.roster.all(), addEntry };
    const box = sealPairingMessage(fromB64(qr.secret), "pair-req", qr.sessionId, utf8(JSON.stringify(payload)));
    return { to: qr.agentId, kind: "pair", ct: toB64(concat(box.nonce, box.ciphertext)) };
  }

  get pairingAgentId(): string | undefined {
    return this.pendingPair?.qr.agentId;
  }

  /**
   * Bilgisayardan "pair-ok" gelince: ajan imzasını doğrula, eş-imzalı girişi ekle, sahip bağını kur.
   * Dönen mesajlar bilgisayara gönderilmelidir (bağ girişi).
   */
  completePairing(from: string, ct: string): WireOut[] {
    const p = this.pendingPair;
    if (!p || p.qr.agentId !== from) throw new Error("NO_PENDING_PAIRING");
    this.pendingPair = undefined;
    const raw = fromB64(ct);
    const plain = openPairingMessage(fromB64(p.qr.secret), "pair-ok", p.qr.sessionId, { nonce: raw.subarray(0, 24), ciphertext: raw.subarray(24) });
    const { entry, agentSig } = JSON.parse(fromUtf8(plain)) as { entry: RosterEntry; agentSig: string };
    // Ajanın eş-imzaladığı giriş, telefonun hazırladığı girişin aynısı olmalı (yalnızca eş-imza eklenmiş).
    const strip = (e: RosterEntry) => toB64(canonicalBytes({ ...e, cosig: null }));
    if (strip(entry) !== strip(p.addEntry)) throw new Error("PAIR_ENTRY_MISMATCH");
    const next = RosterLog.fromEntries(this.roster.all());
    next.appendOne(entry);
    const transcript = canonicalBytes({ ws: this.state.ws, agentId: p.qr.agentId, phoneId: this.state.id, head: next.head() });
    if (!verify("SAKLAZ-v1/pair", transcript, fromB64(agentSig), fromB64(p.qr.signPub))) throw new Error("AGENT_SIG_INVALID");
    this.roster = next;
    const h = this.roster.head();
    const link = signRosterEntry(
      { ws: this.state.ws, seq: h.seq + 1, prev: h.hash, ts: this.now(), op: "link.set", body: { phoneId: this.state.id, computerId: p.qr.agentId, role: "owner" }, signer: this.state.id },
      this.approval.secretKey,
    );
    this.roster.appendOne(link);
    this.persistRoster();
    // Yeni bilgisayar, telefonun bütün listesini (önceki bilgisayarlar dahil) zaten aldı; bağ girişi gönderilir.
    // Diğer bilgisayarlar yeni cihazı ve bağı öğrenir (aksi halde liste geride kalır: ROSTER_BEHIND).
    const out = this.send(p.qr.agentId, "roster.append", { entries: [link] as never });
    for (const c of this.computers()) {
      if (c.deviceId !== p.qr.agentId) out.push(...this.send(c.deviceId, "roster.append", { entries: [entry, link] as never }));
    }
    return out;
  }

  /** Bir bilgisayarı listeden kalıcı olarak çıkarır (sahip imzalı iptal). Diğer bilgisayarlara da gönderilmelidir. */
  revoke(deviceId: string): RosterEntry {
    const d = this.roster.current.devices.get(deviceId);
    if (!d || d.kind !== "computer") throw new Error("UNKNOWN_DEVICE");
    const h = this.roster.head();
    const e = signRosterEntry(
      { ws: this.state.ws, seq: h.seq + 1, prev: h.hash, ts: this.now(), op: "device.revoke", body: { deviceId, reason: "owner" }, signer: this.state.id },
      this.approval.secretKey,
    );
    this.roster.appendOne(e);
    this.persistRoster();
    this.channel.dropPeer(deviceId);
    return e;
  }

  /** İmzalı ve uçtan uca şifreli mesaj. Sayaç kalıcıdır; çağıran durumu kaydetmelidir. */
  send<T extends MessageType>(to: string, type: T, body: Body<T>, opts: { lifetimeMs?: number } = {}): WireOut[] {
    const hdr = buildHeader({
      type,
      ws: this.state.ws,
      rh: this.roster.head(),
      from: this.state.id,
      to,
      ctr: ++this.state.ctr,
      ts: this.now(),
      ...(opts.lifetimeMs !== undefined ? { lifetimeMs: opts.lifetimeMs } : {}),
    });
    const msg = signInnerMessage(hdr, body, this.sign);
    return this.channel.send(to, encodeInnerMessage(msg));
  }

  /** Bilgisayarlardan gelen çerçeveleri çözer, imzayı listeden doğrular, tekrar oynatmayı reddeder. */
  receive(frames: ReceivedFrame[]): ReceiveOutput {
    const out: ReceiveOutput = { replies: [], messages: [], errors: [] };
    for (const f of frames) {
      if (f.kind === "pair") {
        try {
          out.replies.push(...this.completePairing(f.from, f.ct));
        } catch (e) {
          out.errors.push(e instanceof Error ? e.message : "PAIR_FAILED");
        }
        continue;
      }
      let r;
      try {
        r = this.channel.receive(f.from, f.kind, f.ct);
      } catch {
        out.errors.push("DECRYPT_FAILED");
        continue;
      }
      out.replies.push(...r.replies);
      if (!r.plaintext) continue;
      try {
        const msg = decodeInnerMessage(r.plaintext);
        const d = this.roster.current.devices.get(msg.hdr.from);
        if (!d || d.revoked || d.kind !== "computer" || msg.hdr.from !== f.from) throw new Error("UNKNOWN_SENDER");
        if (msg.hdr.ws !== this.state.ws || msg.hdr.to !== this.state.id) throw new Error("WRONG_TARGET");
        verifyInnerMessageSignature(msg, fromB64(d.signPub));
        checkTiming(msg.hdr, this.now());
        if (this.replay.checkAndRecord(msg.hdr.from, msg.hdr.ctr) === "duplicate") continue;
        if (msg.hdr.type === "roster.need") {
          // Bilgisayar listede geride: eksik imzalı girişler gönderilir (girişler zaten imzalıdır; içerik gizli değil).
          const fromSeq = (msg.body as Body<"roster.need">).fromSeq;
          const missing = this.roster.all().filter((e) => e.seq >= fromSeq);
          if (missing.length) out.replies.push(...this.send(msg.hdr.from, "roster.append", { entries: missing as never }));
        }
        out.messages.push(msg);
      } catch (e) {
        out.errors.push(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : "VERIFY_FAILED");
      }
    }
    return out;
  }
}
