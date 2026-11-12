import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { fromB64, generateSigningKeyPair, initCrypto, randomBytes, toB64, verify } from "@saklaz/crypto";
import { canonicalBytes, relayAuthPayload, type ClientFrame } from "@saklaz/protocol";
import { InsecureFileVault, RelayClient, ttlFor, type IncomingFrame } from "../src/index.js";

beforeAll(initCrypto);

const DEV = "dev_transportTest0000001";

/** Küçük sahte relay: kimlik doğrulama adımlarını uygular ve gelen çerçeveleri kaydeder. */
function fakeRelay(signPub: Uint8Array) {
  const wss = new WebSocketServer({ port: 0 });
  const received: ClientFrame[] = [];
  const sockets: WebSocket[] = [];
  let proofOk: boolean | undefined;
  wss.on("connection", (ws) => {
    sockets.push(ws);
    const nonce = toB64(randomBytes(32));
    ws.on("message", (d) => {
      const f = JSON.parse((d as Buffer).toString("utf8")) as ClientFrame;
      received.push(f);
      if (f.t === "auth") ws.send(JSON.stringify({ t: "challenge", nonce, relayId: "fake" }));
      if (f.t === "auth.proof") {
        proofOk = verify("SAKLAZ-v1/relay-auth", canonicalBytes(relayAuthPayload(DEV, nonce, "fake")), fromB64(f.sig), signPub);
        if (proofOk) ws.send(JSON.stringify({ t: "ready", deviceId: DEV, queued: 0 }));
        else ws.close(4000);
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    proofOk: () => proofOk,
    deliver: (n: number) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = randomUUID();
        ids.push(id);
        sockets.at(-1)?.send(JSON.stringify({ t: "deliver", id, from: "dev_peerPhone000000000001", kind: "sealed", ct: "QUJD", sentAt: 1 }));
      }
      return ids;
    },
    dropAll: () => {
      for (const s of sockets) s.terminate();
    },
    connections: () => sockets.length,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.terminate();
        wss.close(() => r());
      }),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const s = Date.now();
  while (!cond()) {
    if (Date.now() - s > ms) throw new Error("zaman aşımı");
    await wait(10);
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  // Ters sırada: önce istemciler durdurulur, sonra sahte sunucu kapatılır.
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("relay istemcisi", () => {
  it("meydan okumayı cihaz anahtarıyla imzalar; hazır olmadan gönderilenler hazır olunca iletilir", async () => {
    const key = generateSigningKeyPair();
    const relay = fakeRelay(key.publicKey);
    cleanups.push(relay.close);
    const c = new RelayClient({ url: relay.url, deviceId: DEV, sign: key, getToken: () => "token-xxxxxxxxxx", onFrames: () => undefined });
    cleanups.push(() => c.stop());
    c.send([{ to: "dev_peerPhone000000000001", kind: "sealed", ct: "QUJD" }]);
    c.start();
    await c.waitReady();
    expect(relay.proofOk()).toBe(true);
    await until(() => relay.received.some((f) => f.t === "send"));
    const sent = relay.received.find((f): f is Extract<ClientFrame, { t: "send" }> => f.t === "send");
    expect(sent?.ttlSec).toBe(ttlFor("sealed"));
    expect(ttlFor("noise")).toBe(600);
    expect(ttlFor("pair")).toBe(300);
  });

  it("yanlış anahtarla bağlanma reddedilir", async () => {
    const relay = fakeRelay(generateSigningKeyPair().publicKey);
    cleanups.push(relay.close);
    const c = new RelayClient({ url: relay.url, deviceId: DEV, sign: generateSigningKeyPair(), getToken: () => "token-xxxxxxxxxx", onFrames: () => undefined, minBackoffMs: 5000 });
    cleanups.push(() => c.stop());
    c.start();
    await until(() => relay.proofOk() === false);
    expect(c.isReady).toBe(false);
    await expect(c.waitReady(100)).rejects.toThrow();
  });

  it("art arda gelen teslimler tek grup halinde işlenir; teslim onayı İŞLENDİKTEN sonra gönderilir", async () => {
    const key = generateSigningKeyPair();
    const relay = fakeRelay(key.publicKey);
    cleanups.push(relay.close);
    const batches: IncomingFrame[][] = [];
    const c = new RelayClient({ url: relay.url, deviceId: DEV, sign: key, getToken: () => "token-xxxxxxxxxx", onFrames: (f) => void batches.push(f) });
    cleanups.push(() => c.stop());
    c.start();
    await c.waitReady();
    const ids = relay.deliver(3);
    await until(() => relay.received.filter((f) => f.t === "delivered").length === 3);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    const acks = relay.received.filter((f): f is Extract<ClientFrame, { t: "delivered" }> => f.t === "delivered");
    expect(acks.map((f) => f.id)).toEqual(ids);
  });

  it("işleme hatasında teslim onayı GÖNDERİLMEZ (relay yeniden iletir)", async () => {
    const key = generateSigningKeyPair();
    const relay = fakeRelay(key.publicKey);
    cleanups.push(relay.close);
    const states: string[] = [];
    const c = new RelayClient({
      url: relay.url,
      deviceId: DEV,
      sign: key,
      getToken: () => "token-xxxxxxxxxx",
      onFrames: () => {
        throw new Error("beklenmeyen");
      },
      onState: (s) => states.push(s),
    });
    cleanups.push(() => c.stop());
    c.start();
    await c.waitReady();
    relay.deliver(2);
    await until(() => states.includes("error"));
    await wait(50);
    expect(relay.received.some((f) => f.t === "delivered")).toBe(false);
  });

  it("bağlantı koparsa yeniden bağlanır; stop() sonrası (ör. acil kilit) yeniden bağlanmaz", async () => {
    const key = generateSigningKeyPair();
    const relay = fakeRelay(key.publicKey);
    cleanups.push(relay.close);
    const c = new RelayClient({ url: relay.url, deviceId: DEV, sign: key, getToken: () => "token-xxxxxxxxxx", onFrames: () => undefined, minBackoffMs: 20 });
    c.start();
    await c.waitReady();
    relay.dropAll();
    await until(() => relay.connections() >= 2);
    await c.waitReady();
    c.presence(["dev_peerPhone000000000001"]);
    await until(() => relay.received.some((f) => f.t === "presence.query"));
    c.stop();
    const n = relay.connections();
    await wait(200);
    expect(relay.connections()).toBe(n);
    expect(c.isReady).toBe(false);
  });
});

describe("güvensiz dosya kasası (yalnızca test/geliştirme)", () => {
  it("ortam değişkeni olmadan açılmayı reddeder; açıkken değerleri atomik olarak yazar", () => {
    const dir = mkdtempSync(join(tmpdir(), "saklaz-vault-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const prev = process.env["SAKLAZ_INSECURE_VAULT"];
    delete process.env["SAKLAZ_INSECURE_VAULT"];
    expect(() => new InsecureFileVault(join(dir, "v.json"))).toThrow(/yalnızca test/);
    process.env["SAKLAZ_INSECURE_VAULT"] = "1";
    try {
      const v = new InsecureFileVault(join(dir, "v.json"));
      expect(v.get("x")).toBeUndefined();
      v.set("x", new Uint8Array([1, 2, 3]));
      expect(new InsecureFileVault(join(dir, "v.json")).get("x")).toEqual(new Uint8Array([1, 2, 3]));
      expect(readFileSync(join(dir, "v.json"), "utf8")).toContain("010203");
      expect(v.kind).toBe("insecure-file");
    } finally {
      if (prev === undefined) delete process.env["SAKLAZ_INSECURE_VAULT"];
      else process.env["SAKLAZ_INSECURE_VAULT"] = prev;
    }
  });
});
