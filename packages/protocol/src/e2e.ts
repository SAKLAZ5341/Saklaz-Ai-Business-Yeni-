/**
 * Uçtan uca kanal — Noise_KK oturumları ve mühürlü zarf yedeği (FAZ1-PLAN §5, ADR-0002, ADR-0007).
 *
 * Saf bir durum makinesidir: G/Ç yapmaz. Giden "tel" (wire) çerçevelerini üretir, gelenleri çözer.
 * Kriptografi Sprint 1'deki @saklaz/crypto'dur; burada yalnızca oturum yönetimi vardır.
 *
 *   sealed  — oturum yokken veya karşı taraf çevrimdışıyken: mühürlü zarf (sınırlı ileri gizlilik, ADR-0007)
 *   hs1/hs2 — Noise_KK el sıkışması (karşılıklı kimlik doğrulama, geçici anahtarlar)
 *   noise   — kurulmuş oturumda taşıma mesajı (ileri gizlilik)
 *
 * Noise taşıma katmanı sıralı ve kayıpsız teslim varsayar. Relay bir mesajı düşürür veya sırasını
 * bozarsa çözme başarısız olur. Bu durumda oturum sıfırlanır, yeni el sıkışma başlatılır ve kayıp
 * mesaj uygulama katmanındaki outbox + ack mekanizmasıyla yeniden gönderilir. Bu, sunucunun mesaj
 * düşürmesine karşı bir kullanılabilirlik önlemidir; bir güvenlik garantisi değildir (SECURITY.md §21).
 */
import {
  concat,
  CryptoError,
  fromB64,
  NoiseKK,
  open as openSealed,
  seal,
  toB64,
  utf8,
  type DhKeyPair,
  type NoiseTransport,
} from "@saklaz/crypto";
import { PROTOCOL_VERSION } from "./schemas.js";

export type WireKind = "sealed" | "hs1" | "hs2" | "noise";

export interface WireOut {
  to: string;
  kind: WireKind;
  /** base64url */
  ct: string;
}

export interface E2EOptions {
  ws: string;
  selfId: string;
  selfDh: DhKeyPair;
  /** Eşleştirmede sabitlenmiş / imzalı listedeki karşı tarafın X25519 açık anahtarı. */
  peerDhPub(peerId: string): Uint8Array | undefined;
  now(): number;
  sessionMaxAgeMs?: number;
  sessionMaxMessages?: number;
}

export interface ReceiveResult {
  plaintext?: Uint8Array;
  replies: WireOut[];
  event?: "session-established" | "session-reset" | "handshake-ignored";
}

interface Session {
  t: NoiseTransport;
  establishedAt: number;
  count: number;
}

export class E2EError extends Error {
  constructor(readonly code: "UNKNOWN_PEER" | "DECRYPT_FAILED" | "BAD_FRAME") {
    super(code);
    this.name = "E2EError";
  }
}

export class E2EChannel {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, NoiseKK>();
  private readonly maxAge: number;
  private readonly maxMsgs: number;

  constructor(private readonly o: E2EOptions) {
    this.maxAge = o.sessionMaxAgeMs ?? 24 * 3_600_000;
    this.maxMsgs = o.sessionMaxMessages ?? 10_000;
  }

  private peerKey(id: string): Uint8Array {
    const k = this.o.peerDhPub(id);
    if (!k) throw new E2EError("UNKNOWN_PEER");
    return k;
  }

  private prologue(initiator: string, responder: string): Uint8Array {
    return utf8(`SAKLAZ-v1|${this.o.ws}|${initiator}|${responder}|${PROTOCOL_VERSION}`);
  }

  private sealedContext(from: string, to: string): Uint8Array {
    return utf8(`SAKLAZ-v1/sealed|${this.o.ws}|${from}|${to}`);
  }

  hasSession(peerId: string): boolean {
    const s = this.sessions.get(peerId);
    return !!s && this.o.now() - s.establishedAt < this.maxAge && s.count < this.maxMsgs;
  }

  /** Oturum kurulmasını başlatır (hs1). Zaten bekleyen bir el sıkışma varsa yenisini başlatmaz. */
  startHandshake(peerId: string): WireOut | undefined {
    if (this.pending.has(peerId)) return undefined;
    const hs = new NoiseKK({
      initiator: true,
      prologue: this.prologue(this.o.selfId, peerId),
      s: this.o.selfDh,
      rs: this.peerKey(peerId),
    });
    this.pending.set(peerId, hs);
    return { to: peerId, kind: "hs1", ct: toB64(hs.writeMessage()) };
  }

  /** Oturum varsa Noise ile, yoksa mühürlü zarfla şifreler; gerekirse el sıkışmayı da başlatır. */
  send(peerId: string, plaintext: Uint8Array): WireOut[] {
    const s = this.sessions.get(peerId);
    if (s && this.hasSession(peerId)) {
      s.count++;
      return [{ to: peerId, kind: "noise", ct: toB64(s.t.send.encryptWithAd(new Uint8Array(0), plaintext)) }];
    }
    if (s) this.sessions.delete(peerId); // süresi doldu → yenile
    const out: WireOut[] = [];
    const hs = this.startHandshake(peerId);
    if (hs) out.push(hs);
    const box = seal(this.o.selfDh, this.peerKey(peerId), plaintext, this.sealedContext(this.o.selfId, peerId));
    out.push({ to: peerId, kind: "sealed", ct: toB64(concat(box.ephemeralPublicKey, box.nonce, box.ciphertext)) });
    return out;
  }

  receive(from: string, kind: WireKind, ctB64: string): ReceiveResult {
    let ct: Uint8Array;
    try {
      ct = fromB64(ctB64);
    } catch {
      throw new E2EError("BAD_FRAME");
    }
    const rs = this.peerKey(from);
    try {
      switch (kind) {
        case "sealed": {
          if (ct.length < 32 + 24 + 16) throw new E2EError("BAD_FRAME");
          const pt = openSealed(
            this.o.selfDh,
            rs,
            { ephemeralPublicKey: ct.subarray(0, 32), nonce: ct.subarray(32, 56), ciphertext: ct.subarray(56) },
            this.sealedContext(from, this.o.selfId),
          );
          return { plaintext: pt, replies: [] };
        }
        case "hs1": {
          // Eşzamanlı başlatma (glare): kimliği küçük olan taraf başlatıcı kalır.
          if (this.pending.has(from) && this.o.selfId < from) return { replies: [], event: "handshake-ignored" };
          this.pending.delete(from);
          const hs = new NoiseKK({ initiator: false, prologue: this.prologue(from, this.o.selfId), s: this.o.selfDh, rs });
          hs.readMessage(ct);
          const reply = hs.writeMessage();
          this.sessions.set(from, { t: hs.split(), establishedAt: this.o.now(), count: 0 });
          return { replies: [{ to: from, kind: "hs2", ct: toB64(reply) }], event: "session-established" };
        }
        case "hs2": {
          const hs = this.pending.get(from);
          if (!hs) return { replies: [], event: "handshake-ignored" };
          hs.readMessage(ct);
          this.pending.delete(from);
          this.sessions.set(from, { t: hs.split(), establishedAt: this.o.now(), count: 0 });
          return { replies: [], event: "session-established" };
        }
        case "noise": {
          const s = this.sessions.get(from);
          if (!s) {
            // Oturum yok (ör. yeniden başlatma sonrası): yeni el sıkışma iste; mesaj outbox'tan tekrar gelecek.
            const hs = this.startHandshake(from);
            return { replies: hs ? [hs] : [], event: "session-reset" };
          }
          try {
            const pt = s.t.recv.decryptWithAd(new Uint8Array(0), ct);
            s.count++;
            return { plaintext: pt, replies: [] };
          } catch (e) {
            if (!(e instanceof CryptoError)) throw e;
            // Kayıp, sıra bozukluğu veya kurcalama: oturumu at ve yeniden kur.
            this.sessions.delete(from);
            const hs = this.startHandshake(from);
            return { replies: hs ? [hs] : [], event: "session-reset" };
          }
        }
      }
    } catch (e) {
      if (e instanceof E2EError) throw e;
      if (e instanceof CryptoError) {
        if (kind === "hs1" || kind === "hs2") this.pending.delete(from);
        throw new E2EError("DECRYPT_FAILED");
      }
      throw e;
    }
  }

  /** Acil kilitte veya cihaz iptalinde: oturum anahtarlarını bellekten at. */
  dropPeer(peerId: string): void {
    const s = this.sessions.get(peerId);
    if (s) {
      s.t.send.destroy();
      s.t.recv.destroy();
    }
    this.sessions.delete(peerId);
    this.pending.delete(peerId);
  }

  dropAll(): void {
    for (const id of [...this.sessions.keys(), ...this.pending.keys()]) this.dropPeer(id);
  }
}
