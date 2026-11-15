/**
 * Relay WebSocket'i kabuk üzerinden: köprü protokolü, onay iptali/reddi sonrası yeniden bağlanmanın
 * durması, CSP'nin WebView'ın doğrudan ağ bağlantısını engellemesi.
 */
import { readFileSync } from "node:fs";
import { RelayConnection, type WebSocketLike } from "@saklaz/client-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relaySocketFactory } from "../src/app.js";
import { BridgeHost, HostSocket, isTerminalClose, SOCKET_CLOSE, type Host, type HttpContext } from "../src/host.js";

type Msg = { id: number; op: string; args: Record<string, unknown> };
const g = globalThis as unknown as { window: Record<string, unknown> };
function at<T>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new Error(`öğe yok: ${i}`);
  return v;
}

function bridge() {
  g.window = {};
  const sent: Msg[] = [];
  const host = new BridgeHost({ postMessage: (m) => sent.push(JSON.parse(m) as Msg) });
  const w = g.window as { __saklazReply: (j: string) => void; __saklazWsEvent: (j: string) => void };
  const reply = (id: number, r: { ok: boolean; value?: unknown; error?: string }) => w.__saklazReply(JSON.stringify({ id, ...r }));
  const event = (e: Record<string, unknown>) => w.__saklazWsEvent(JSON.stringify(e));
  return { host, sent, reply, event };
}

describe("BridgeHost.openSocket — kabuk köprüsü", () => {
  it("ws.open amaç ve alanla istenir; açılış, mesaj, gönderim ve kabuğun kapatması iletilir", async () => {
    const { host, sent, reply, event } = bridge();
    const s = host.openSocket("wss://relay.ornek.com/v1/connect", { purpose: "relay", scope: "business" });
    const ev: string[] = [];
    s.onopen = () => ev.push("open");
    s.onmessage = (m) => ev.push(`msg:${String(m.data)}`);
    s.onerror = () => ev.push("error");
    s.onclose = (c) => ev.push(`close:${(c as { code: number }).code}`);
    const open = at(sent, 0);
    expect(open.op).toBe("ws.open");
    expect(open.args).toMatchObject({ url: "wss://relay.ornek.com/v1/connect", purpose: "relay", scope: "business" });
    const sid = open.args["sid"] as string;
    expect(sid).toMatch(/^[0-9a-f]{32}$/);
    expect(s.readyState).toBe(0);
    expect(() => s.send("x")).toThrow("SOCKET_NOT_OPEN");
    event({ sid, ev: "open" });
    reply(open.id, { ok: true, value: null });
    await Promise.resolve();
    expect(s.readyState).toBe(1);
    event({ sid, ev: "message", data: "merhaba" });
    event({ sid: "baska", ev: "message", data: "yok sayılır" });
    s.send("yanit");
    expect(sent[1]).toMatchObject({ op: "ws.send", args: { sid, data: "yanit" } });
    event({ sid, ev: "close", code: SOCKET_CLOSE.CONSENT_REVOKED, reason: "CONSENT_REVOKED" });
    event({ sid, ev: "message", data: "kapandıktan sonra" });
    const before = sent.length;
    s.send("kapandıktan sonra gönderim");
    expect(sent.length).toBe(before);
    expect(ev).toEqual(["open", "msg:merhaba", "error", `close:${SOCKET_CLOSE.CONSENT_REVOKED}`]);
    expect(s.readyState).toBe(3);
  });

  it("kabuk ws.open'ı reddederse (onay yok / politika) soket kodla kapanır", async () => {
    for (const [error, code] of [
      ["HOST_DENIED", SOCKET_CLOSE.HOST_DENIED],
      ["CONSENT_REVOKED", SOCKET_CLOSE.CONSENT_REVOKED],
      ["CLEARTEXT_BLOCKED", SOCKET_CLOSE.POLICY],
      ["TARGET_FORBIDDEN", SOCKET_CLOSE.POLICY],
      ["NETWORK", SOCKET_CLOSE.FAILED],
    ] as const) {
      const { host, sent, reply } = bridge();
      const s = host.openSocket("wss://r.ornek.com", { purpose: "relay", scope: "personal" });
      let closed = -1;
      s.onclose = (c) => (closed = (c as { code: number }).code);
      reply(at(sent, 0).id, { ok: false, error });
      await new Promise((r) => setTimeout(r, 0));
      expect(closed, error).toBe(code);
      expect(s.readyState).toBe(3);
    }
  });

  it("arayüz kapatınca kabuğa ws.close gider ve soket bir kez kapanır", () => {
    const { host, sent } = bridge();
    const s = host.openSocket("wss://r.ornek.com", { purpose: "relay", scope: "personal" });
    let n = 0;
    s.onclose = () => n++;
    s.close(1000, "stop");
    s.close(1000, "stop");
    expect(sent.filter((m) => m.op === "ws.close")).toHaveLength(1);
    expect(n).toBe(1);
  });

  it("sonlandırıcı kodlar: onay iptali, onay reddi, politika; ağ hatası değil", () => {
    expect(isTerminalClose(SOCKET_CLOSE.CONSENT_REVOKED)).toBe(true);
    expect(isTerminalClose(SOCKET_CLOSE.HOST_DENIED)).toBe(true);
    expect(isTerminalClose(SOCKET_CLOSE.POLICY)).toBe(true);
    expect(isTerminalClose(SOCKET_CLOSE.FAILED)).toBe(false);
    expect(isTerminalClose(1006)).toBe(false);
  });
});

/** Kabuk benzetimi: her openSocket bir HostSocket döndürür; test kapanışı tetikler. */
class FakeHost {
  readonly opened: { url: string; ctx: HttpContext; s: HostSocket }[] = [];
  openSocket(url: string, ctx: HttpContext): WebSocketLike {
    const s = new HostSocket(String(this.opened.length), () => Promise.resolve());
    this.opened.push({ url, ctx, s });
    return s;
  }
}

describe("relay bağlantısı: onay iptali/reddi sonrası yeniden bağlanma YOK", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function conn(fake: FakeHost) {
    const stopped: string[] = [];
    const states: string[] = [];
    const c: RelayConnection = new RelayConnection({
      url: "wss://relay.ornek.com/v1/connect",
      deviceId: "d",
      sign: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      getToken: () => Promise.resolve("t"),
      onFrames: () => undefined,
      onState: (s, code) => states.push(code ? `${s}:${code}` : s),
      createSocket: relaySocketFactory(fake as unknown as Host, "business", (code) => {
        stopped.push(code);
        c.stop();
      }),
      minBackoffMs: 100,
      maxBackoffMs: 1000,
    });
    return { c, stopped, states };
  }

  it("ağ kopması (1006) → yeniden bağlanır; her girişim kabuktan (politika + onay) geçer", async () => {
    const fake = new FakeHost();
    const { c } = conn(fake);
    c.start();
    expect(fake.opened).toHaveLength(1);
    expect(at(fake.opened, 0).ctx).toEqual({ purpose: "relay", scope: "business" });
    at(fake.opened, 0).s.finish(1006, "");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.opened.length).toBeGreaterThanOrEqual(2);
    c.stop();
  });

  for (const [name, code] of [
    ["CONSENT_REVOKED", SOCKET_CLOSE.CONSENT_REVOKED],
    ["HOST_DENIED", SOCKET_CLOSE.HOST_DENIED],
    ["SOCKET_POLICY", SOCKET_CLOSE.POLICY],
  ] as const) {
    it(`${name} → bağlantı durur, 10 dakika boyunca yeniden bağlanma denenmez`, async () => {
      const fake = new FakeHost();
      const { c, stopped } = conn(fake);
      c.start();
      at(fake.opened, 0).s.dispatch({ sid: "0", ev: "open" });
      at(fake.opened, 0).s.finish(code, name);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(stopped).toEqual([name]);
      expect(fake.opened).toHaveLength(1);
      expect(c.isReady).toBe(false);
    });
  }

  it("yeni oturum (kullanıcının yeniden bağlanması) yeni bir kabuk açılışıdır → kabuk yeniden onay sorar", () => {
    const fake = new FakeHost();
    const a = conn(fake);
    a.c.start();
    a.c.stop();
    const b = conn(fake);
    b.c.start();
    expect(fake.opened).toHaveLength(2);
    b.c.stop();
  });
});

describe("CSP: WebView doğrudan ağ bağlantısı açamaz", () => {
  it("index.html connect-src 'none'; ws:/wss:/http(s): izni yok", () => {
    const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/connect-src[^;]*(ws:|wss:|https?:)/);
  });
  it("derleme betiği üretim dosyasında connect-src 'none' olmadan durur", () => {
    const b = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");
    expect(b).toContain(`if (!html.includes("connect-src 'none'")) throw`);
    expect(b).toContain(`dev ? "dist/index.dev-insecure.html" : "dist/index.html"`);
  });
});
