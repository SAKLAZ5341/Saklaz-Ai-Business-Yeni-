/**
 * Çapraz platform test vektörleri (SECURITY.md S13, FAZ1-PLAN §10.1).
 *
 * Android (Dart) uygulaması, bu dosyadaki her vektörü kendi kriptografi ve kanonik JSON
 * uygulamasıyla BİREBİR üretmek zorundadır. Bir uyumsuzluk, telefonun imzaladığı komutların
 * ajan tarafından reddedilmesi demektir; bu yüzden vektörler CI'da iki tarafta da çalıştırılır.
 *
 * Tüm girdiler sabittir (tohumlar, geçici anahtarlar, nonce'lar). Ed25519 deterministik olduğu
 * için çıktılar da sabittir. Bu betiği yeniden çalıştırmak aynı dosyayı üretmelidir; test
 * (test/vectors.test.ts) bunu denetler.
 *
 * Kullanım:  pnpm --filter @saklaz/protocol run vectors      (dosyayı yazar)
 */
import { writeFileSync } from "node:fs";
import {
  blake2b,
  computeSas,
  dh,
  dhKeyPairFromSecret,
  hkdf,
  initCrypto,
  seal,
  sign,
  signingKeyPairFromSeed,
  taggedHash,
  toB64,
  toHex,
  utf8,
} from "@saklaz/crypto";
import {
  approvalDigestInput,
  approvalSigningBytes,
  canonicalize,
  computeApprovalDigest,
  cosignRosterEntry,
  messageSigningBytes,
  PROTOCOL_VERSION,
  ROSTER_GENESIS_PREV,
  rosterEntryHash,
  signInnerMessage,
  signRosterEntry,
  type Header,
} from "../src/index.js";

const seed = (b: number) => new Uint8Array(32).fill(b);

export async function generateVectors(): Promise<unknown> {
  await initCrypto();

  // ---- JCS ----
  const jcsCases: { input: unknown; canonical: string }[] = [
    { input: { b: 1, a: [true, null, "x"] }, canonical: "" },
    { input: { "\u20ac": "Euro", "\r": "CR", "1": "One", "\ud83d\ude00": "Emoji", "\u00f6": "ö" }, canonical: "" },
    { input: { text: "Satınalma \"talebi\"\n\t\\ / ğüşiöç İ", n: -9007199254740991 }, canonical: "" },
    { input: [], canonical: "" },
    { input: { nested: { z: { y: { x: [1, [2, [3]]] } } } }, canonical: "" },
  ];
  for (const c of jcsCases) c.canonical = canonicalize(c.input);

  // ---- Anahtarlar ----
  const phoneSign = signingKeyPairFromSeed(seed(0x01));
  const phoneApproval = signingKeyPairFromSeed(seed(0x02));
  const agentSign = signingKeyPairFromSeed(seed(0x03));
  const phoneDh = dhKeyPairFromSecret(seed(0x11));
  const agentDh = dhKeyPairFromSecret(seed(0x12));

  // ---- Ed25519 + alan ayrımı ----
  const msgBytes = utf8("SAKLAZ test mesajı");
  const signatures = (["SAKLAZ-v1/msg", "SAKLAZ-v1/approval", "SAKLAZ-v1/pair"] as const).map((domain) => ({
    domain,
    seedHex: toHex(seed(0x01)),
    publicKeyHex: toHex(phoneSign.publicKey),
    messageHex: toHex(msgBytes),
    signatureHex: toHex(sign(domain, msgBytes, phoneSign.secretKey)),
  }));

  // ---- Özetler ve HKDF ----
  const hashes = {
    blake2b512_abc: toHex(blake2b(utf8("abc"))),
    tagged_sas_32: toHex(taggedHash("SAKLAZ-SAS-v1", utf8("abc"), 32)),
    hkdf_sealed_42: toHex(hkdf(utf8("ikm"), utf8("salt"), "SAKLAZ-v1/sealed", 42)),
    hkdf_empty_salt_32: toHex(hkdf(utf8("ikm"), new Uint8Array(0), "SAKLAZ-v1/pair-req", 32)),
  };

  // ---- X25519 ----
  const x25519 = {
    phoneSecretHex: toHex(phoneDh.secretKey),
    phonePublicHex: toHex(phoneDh.publicKey),
    agentSecretHex: toHex(agentDh.secretKey),
    agentPublicHex: toHex(agentDh.publicKey),
    sharedHex: toHex(dh(phoneDh.secretKey, agentDh.publicKey)),
  };

  // ---- SAS ----
  const pairingSecret = seed(0x21);
  const sas = {
    secretHex: toHex(pairingSecret),
    agentSignPubHex: toHex(agentSign.publicKey),
    agentDhPubHex: toHex(agentDh.publicKey),
    phoneSignPubHex: toHex(phoneSign.publicKey),
    phoneDhPubHex: toHex(phoneDh.publicKey),
    sas: computeSas({
      secret: pairingSecret,
      agentSignPub: agentSign.publicKey,
      agentDhPub: agentDh.publicKey,
      phoneSignPub: phoneSign.publicKey,
      phoneDhPub: phoneDh.publicKey,
    }),
  };

  // ---- Mühürlü zarf (telefon → çevrimdışı ajan) ----
  const eph = dhKeyPairFromSecret(seed(0x31));
  const sealedNonce = new Uint8Array(24).fill(0x41);
  const context = utf8("env:01934b6e-0000-7000-8000-00000000abcd");
  const plaintext = utf8('{"komut":"rapor"}');
  const box = seal(phoneDh, agentDh.publicKey, plaintext, context, { ephemeral: eph, nonce: sealedNonce });
  const sealed = {
    senderSecretHex: toHex(phoneDh.secretKey),
    recipientPublicHex: toHex(agentDh.publicKey),
    ephemeralSecretHex: toHex(eph.secretKey),
    nonceHex: toHex(sealedNonce),
    contextHex: toHex(context),
    plaintextHex: toHex(plaintext),
    ephemeralPublicHex: toHex(box.ephemeralPublicKey),
    ciphertextHex: toHex(box.ciphertext),
  };

  // ---- İmzalı iç mesaj ----
  const AGENT = "dev_vectorAgent000000001";
  const PHONE = "dev_vectorPhone000000001";
  const WS = "ws_vectorPersonal000001";

  // ---- İmzalı cihaz listesi (ADR-0014) ----
  const genesis = signRosterEntry(
    {
      ws: WS,
      seq: 0,
      prev: ROSTER_GENESIS_PREV,
      ts: 1_794_000_000_000,
      op: "genesis",
      body: {
        device: {
          kind: "phone",
          deviceId: PHONE,
          label: "Ana telefon",
          signPub: toB64(phoneSign.publicKey),
          approvalPub: toB64(phoneApproval.publicKey),
          dhPub: toB64(phoneDh.publicKey),
          owner: true,
        },
        recoveryPub: null,
        policy: { recoveryDelayHours: 72 },
      },
      signer: PHONE,
    },
    phoneApproval.secretKey,
  );
  const addAgent = cosignRosterEntry(
    signRosterEntry(
      {
        ws: WS,
        seq: 1,
        prev: rosterEntryHash(genesis),
        ts: 1_794_000_000_500,
        op: "device.add",
        body: { device: { kind: "computer", deviceId: AGENT, label: "Ev bilgisayarı", signPub: toB64(agentSign.publicKey), dhPub: toB64(agentDh.publicKey) } },
        signer: PHONE,
      },
      phoneApproval.secretKey,
    ),
    agentSign.secretKey,
  );
  const link = signRosterEntry(
    { ws: WS, seq: 2, prev: rosterEntryHash(addAgent), ts: 1_794_000_000_900, op: "link.set", body: { phoneId: PHONE, computerId: AGENT, role: "owner" }, signer: PHONE },
    phoneApproval.secretKey,
  );
  const roster = {
    entries: [genesis, addAgent, link],
    hashes: [rosterEntryHash(genesis), rosterEntryHash(addAgent), rosterEntryHash(link)],
  };

  const hdr: Header & { type: "cmd.create" } = {
    proto: PROTOCOL_VERSION,
    ws: WS,
    rh: { seq: 2, hash: rosterEntryHash(link) },
    type: "cmd.create",
    msgId: "01934b6e-0000-7000-8000-000000000042",
    from: PHONE,
    to: AGENT,
    ctr: 7,
    ts: 1_794_000_000_000,
    exp: 1_794_000_000_000 + 24 * 3_600_000,
    nonce: toB64(new Uint8Array(16).fill(0x51)),
  };
  const body = { taskId: "01934b6e-0000-7000-8000-000000000043", text: "Raporlar klasöründeki Excel dosyalarını özetle" };
  const signed = signInnerMessage(hdr, body, phoneSign);
  const message = {
    signerSeedHex: toHex(seed(0x01)),
    signerPublicHex: toHex(phoneSign.publicKey),
    hdr,
    body,
    signingBytesHex: toHex(messageSigningBytes(hdr, body)),
    sig: signed.sig,
  };

  // ---- İşleme bağlı onay ----
  const approvalCtx = {
    workspaceId: WS,
    agentId: AGENT,
    phoneId: PHONE,
    approvalId: "01934b6e-0000-7000-8000-000000000044",
    taskId: body.taskId,
    stepId: "s1",
    action: {
      toolKey: "fs.moveToRecycleBin",
      risk: "critical" as const,
      summary: "1 dosya Geri Dönüşüm Kutusu'na taşınacak",
      targets: [{ kind: "file" as const, value: "C:\\SAKLAZ-TEST\\ornek.xlsx" }],
      params: { paths: ["C:\\SAKLAZ-TEST\\ornek.xlsx"] },
    },
    challenge: toB64(new Uint8Array(32).fill(0x61)),
    issuedAt: 1_794_000_100_000,
    expiresInSec: 600,
  };
  const digest = toB64(computeApprovalDigest(approvalCtx));
  const approvalBytes = approvalSigningBytes({
    workspaceId: WS,
    agentId: AGENT,
    phoneId: PHONE,
    approvalId: approvalCtx.approvalId,
    digest,
    decision: "approve",
    challenge: approvalCtx.challenge,
  });
  const approval = {
    context: approvalCtx,
    digestInputHex: toHex(approvalDigestInput(approvalCtx)),
    digest,
    approvalSignerSeedHex: toHex(seed(0x02)),
    approvalSignerPublicHex: toHex(phoneApproval.publicKey),
    decision: "approve",
    signingBytesHex: toHex(approvalBytes),
    approvalSig: toB64(sign("SAKLAZ-v1/approval", approvalBytes, phoneApproval.secretKey)),
  };

  return {
    version: 2,
    protocol: PROTOCOL_VERSION,
    notes:
      "Tüm ikili değerler hex (…Hex) veya base64url dolgusuz (sig, digest, nonce, challenge). " +
      "Noise_KK vektörü: packages/crypto/test/vectors/noise-kk-blake2b.json (resmî cacophony).",
    jcs: jcsCases,
    signatures,
    hashes,
    x25519,
    sas,
    sealed,
    roster,
    message,
    approval,
  };
}

export const VECTORS_PATH = new URL("../test-vectors/saklaz-v1.json", import.meta.url);

if (process.argv.includes("--write")) {
  const v = await generateVectors();
  writeFileSync(VECTORS_PATH, JSON.stringify(v, null, 2) + "\n");
  console.log(`Yazıldı: ${VECTORS_PATH.pathname}`);
}
