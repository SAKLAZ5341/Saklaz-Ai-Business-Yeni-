import {
  generateSigningKeyPair,
  initCrypto,
  toB64,
  type SigningKeyPair,
} from "@saklaz/crypto";
import {
  buildHeader,
  encodeInnerMessage,
  MemoryReplayStore,
  signInnerMessage,
  IncomingVerifier,
  type Body,
  type DeviceRole,
  type MessageType,
  type PairedPhone,
  type VerifierPolicy,
} from "../src/index.js";

export const NOW = 1_794_000_000_000; // sabit test saati (2026-11)
export const AGENT_ID = "dev_agentAAAAAAAAAAAAAAAA";
export const PHONE_ID = "dev_phoneBBBBBBBBBBBBBBBB";

export async function setup() {
  await initCrypto();
}

export interface Phone {
  id: string;
  sign: SigningKeyPair;
  approval: SigningKeyPair;
  role: DeviceRole;
  ctr: number;
}

export function makePhone(id = PHONE_ID, role: DeviceRole = "owner"): Phone {
  return { id, sign: generateSigningKeyPair(), approval: generateSigningKeyPair(), role, ctr: 0 };
}

export function makeVerifier(phones: Phone[], policy?: VerifierPolicy, revoked: string[] = []) {
  const dir = new Map<string, PairedPhone>(
    phones.map((p) => [
      p.id,
      { deviceId: p.id, role: p.role, signPub: p.sign.publicKey, approvalSignPub: p.approval.publicKey, revoked: revoked.includes(p.id) },
    ]),
  );
  return new IncomingVerifier(AGENT_ID, { get: (id) => dir.get(id) }, new MemoryReplayStore(), policy);
}

export function send<T extends MessageType>(
  p: Phone,
  type: T,
  body: Body<T>,
  opts: { ts?: number; lifetimeMs?: number; to?: string; ctr?: number; signer?: SigningKeyPair } = {},
) {
  const ctr = opts.ctr ?? ++p.ctr;
  const hdr = buildHeader({
    type,
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
