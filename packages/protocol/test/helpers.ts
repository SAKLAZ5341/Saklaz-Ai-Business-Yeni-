import {
  generateDhKeyPair,
  generateSigningKeyPair,
  initCrypto,
  toB64,
  type SigningKeyPair,
} from "@saklaz/crypto";
import {
  buildHeader,
  cosignRosterEntry,
  encodeInnerMessage,
  IncomingVerifier,
  MemoryReplayStore,
  ROSTER_GENESIS_PREV,
  RosterLog,
  signInnerMessage,
  signRosterEntry,
  type Body,
  type DeviceRole,
  type EntryDraft,
  type MessageType,
  type RosterDevice,
  type RosterEntry,
  type VerifierPolicy,
} from "../src/index.js";

export const NOW = 1_794_000_000_000; // sabit test saati (2026-11)
export const WS = "ws_personalAAAAAAAAAAAAA";
export const OTHER_WS = "ws_businessBBBBBBBBBBBBB";
export const AGENT_ID = "dev_agentAAAAAAAAAAAAAAAA";
export const PHONE_ID = "dev_phoneBBBBBBBBBBBBBBBB";

export async function setup() {
  await initCrypto();
}

export interface Phone {
  id: string;
  sign: SigningKeyPair;
  approval: SigningKeyPair;
  dh: { publicKey: Uint8Array; secretKey: Uint8Array };
  role: DeviceRole;
  ctr: number;
}

export function makePhone(id = PHONE_ID, role: DeviceRole = "owner"): Phone {
  return { id, sign: generateSigningKeyPair(), approval: generateSigningKeyPair(), dh: generateDhKeyPair(), role, ctr: 0 };
}

export function phoneDevice(p: Phone, owner: boolean): RosterDevice {
  return {
    kind: "phone",
    deviceId: p.id,
    label: `Telefon ${p.id.slice(4, 10)}`,
    signPub: toB64(p.sign.publicKey),
    approvalPub: toB64(p.approval.publicKey),
    dhPub: toB64(p.dh.publicKey),
    owner,
  };
}

export interface Agent {
  id: string;
  sign: SigningKeyPair;
  dh: { publicKey: Uint8Array; secretKey: Uint8Array };
}

export function makeAgent(id = AGENT_ID): Agent {
  return { id, sign: generateSigningKeyPair(), dh: generateDhKeyPair() };
}

export function computerDevice(a: Agent): RosterDevice {
  return { kind: "computer", deviceId: a.id, label: "Ev bilgisayarı", signPub: toB64(a.sign.publicKey), dhPub: toB64(a.dh.publicKey) };
}

/** Sahibin imzaladığı girişleri sırayla üreten küçük yardımcı (telefon tarafı davranışının taklidi). */
export class RosterBuilder {
  readonly log = new RosterLog();
  constructor(
    readonly ws: string,
    readonly owner: Phone,
    recoveryPub: string | null = null,
  ) {
    const g = signRosterEntry(
      {
        ws,
        seq: 0,
        prev: ROSTER_GENESIS_PREV,
        ts: NOW,
        op: "genesis",
        body: { device: phoneDevice(owner, true), recoveryPub, policy: { recoveryDelayHours: 72 } },
        signer: owner.id,
      },
      owner.approval.secretKey,
    );
    this.log.appendOne(g);
  }

  draft(op: EntryDraft["op"], body: unknown, signer: Phone = this.owner): EntryDraft {
    const h = this.log.head();
    return { ws: this.ws, seq: h.seq + 1, prev: h.hash, ts: NOW, op, body, signer: signer.id };
  }

  next(op: EntryDraft["op"], body: unknown, signer: Phone = this.owner, cosigner?: SigningKeyPair): RosterEntry {
    let e = signRosterEntry(this.draft(op, body, signer), signer.approval.secretKey);
    if (cosigner) e = cosignRosterEntry(e, cosigner.secretKey);
    this.log.appendOne(e);
    return e;
  }

  addPhone(p: Phone, owner = false) {
    return this.next("device.add", { device: phoneDevice(p, owner) }, this.owner, p.sign);
  }
  addAgent(a: Agent) {
    return this.next("device.add", { device: computerDevice(a) }, this.owner, a.sign);
  }
  link(p: Phone, a: Agent | string, role: DeviceRole) {
    return this.next("link.set", { phoneId: p.id, computerId: typeof a === "string" ? a : a.id, role });
  }
  revoke(id: string) {
    return this.next("device.revoke", { deviceId: id, reason: "test" });
  }
}

/**
 * Tek alanlı test dünyası: ilk "owner" rollü telefon (yoksa gizli bir yönetici telefon) alanın sahibidir.
 * Her telefon, ajanla kendi rolüyle bağlanır (cihazlar arası ayrı güven ilişkileri).
 */
let defaultRoster: RosterLog | undefined;

/**
 * Tek alanlı test dünyası. Listenin sahibi ayrı bir "yönetici telefon"dur; test telefonları
 * ajana kendi rolleriyle bağlanır (liste sahipliği ile telefon–bilgisayar bağ rolü ayrı kavramlardır).
 */
export function makeWorld(phones: Phone[], opts: { policy?: VerifierPolicy; revoked?: string[]; ws?: string } = {}) {
  const ws = opts.ws ?? WS;
  const admin = makePhone("dev_rosterAdminZZZZZZZZZZ", "owner");
  const b = new RosterBuilder(ws, admin);
  const agent = makeAgent();
  b.addAgent(agent);
  for (const p of phones) {
    b.addPhone(p);
    b.link(p, agent, p.role);
  }
  for (const id of opts.revoked ?? []) b.revoke(id);
  const verifier = new IncomingVerifier(ws, agent.id, b.log, new MemoryReplayStore(), opts.policy);
  defaultRoster = b.log;
  return { ws, agent, admin, builder: b, roster: b.log, verifier };
}

export function makeVerifier(phones: Phone[], policy?: VerifierPolicy, revoked: string[] = []) {
  return makeWorld(phones, { ...(policy ? { policy } : {}), revoked }).verifier;
}

export function send<T extends MessageType>(
  p: Phone,
  type: T,
  body: Body<T>,
  opts: {
    ts?: number;
    lifetimeMs?: number;
    to?: string;
    ctr?: number;
    signer?: SigningKeyPair;
    ws?: string;
    rh?: { seq: number; hash: string };
    roster?: RosterLog;
  } = {},
) {
  const ctr = opts.ctr ?? ++p.ctr;
  const hdr = buildHeader({
    type,
    ws: opts.ws ?? WS,
    rh: opts.rh ?? (opts.roster ?? defaultRoster)?.head() ?? { seq: 0, hash: ROSTER_GENESIS_PREV },
    from: p.id,
    to: opts.to ?? AGENT_ID,
    ctr,
    ts: opts.ts ?? NOW,
    ...(opts.lifetimeMs !== undefined ? { lifetimeMs: opts.lifetimeMs } : {}),
  });
  return signInnerMessage(hdr, body, opts.signer ?? p.sign);
}

export const bytesOf = encodeInnerMessage;
export const TASK = "01934b6e-0000-7000-8000-000000000001";
export const fakeB64 = (n: number) => toB64(new Uint8Array(n));
