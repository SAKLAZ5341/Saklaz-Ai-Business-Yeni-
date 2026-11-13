/**
 * MVP alfa ajan katmanı: şifreli dosya kasası, izinli komutlar, servis, günlük ve üretim telefon
 * istemcisiyle (@saklaz/client-core) relay'siz eşleştirme + komut.
 * Gerçek relay ve PostgreSQL ile aynı akış: apps/relay/test/mvp-e2e.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCrypto, randomBytes } from "@saklaz/crypto";
import { decodePairingQr, PhoneClient } from "@saklaz/client-core";
import type { InnerMessage, WireOut } from "@saklaz/protocol";
import {
  AgentService,
  allowedCommandNames,
  EncryptedFileVault,
  helpText,
  isProfile,
  openVault,
  profileDir,
  runCommand,
  validateRelayUrl,
  VaultError,
} from "../src/index.js";
import { createFileLogger } from "../src/app/logger.js";
import { FakeProtector } from "./fake-protector.js";

beforeAll(initCrypto);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "saklaz-mvp-"));
  dirs.push(d);
  return d;
}
const noLog = () => undefined;

describe("EncryptedFileVault", () => {
  it("şifreli gidiş-dönüş; dosyada düz metin yok; yanlış anahtar / profil / bozulma → VAULT_CORRUPT", () => {
    const p = join(tmp(), "v", "vault.bin");
    const kek = randomBytes(32);
    const v = new EncryptedFileVault(p, kek, "personal");
    expect(v.kind).toBe("dpapi");
    expect(v.get("x")).toBeUndefined();
    v.set("relay-refresh", new TextEncoder().encode("GIZLI-YENILEME-TOKENI"));
    v.set("b", Uint8Array.of(1, 2, 3));
    v.delete("b");
    v.delete("yok");
    const file = readFileSync(p);
    expect(file.subarray(0, 4).toString()).toBe("SKV1");
    expect(file.includes(Buffer.from("GIZLI"))).toBe(false);
    const again = new EncryptedFileVault(p, kek, "personal");
    expect(new TextDecoder().decode(again.get("relay-refresh"))).toBe("GIZLI-YENILEME-TOKENI");
    expect(again.get("b")).toBeUndefined();
    expect(() => new EncryptedFileVault(p, randomBytes(32), "personal")).toThrow(VaultError);
    expect(() => new EncryptedFileVault(p, kek, "business")).toThrow("VAULT_CORRUPT"); // profil izolasyonu
    const t = Buffer.from(file);
    t[t.length - 1] = (t[t.length - 1] ?? 0) ^ 1;
    writeFileSync(p, t);
    expect(() => new EncryptedFileVault(p, kek, "personal")).toThrow("VAULT_CORRUPT");
    writeFileSync(p, Buffer.from("SKV1"));
    expect(() => new EncryptedFileVault(p, kek, "personal")).toThrow("VAULT_CORRUPT");
    expect(() => new EncryptedFileVault(p, randomBytes(16), "personal")).toThrow("VAULT_KEY");
  });

  it("openVault: koruyucu yoksa ve Windows değilse güvensiz kasa yalnızca açık izinle", () => {
    const d = tmp();
    if (process.platform !== "win32") {
      vi.stubEnv("SAKLAZ_INSECURE_VAULT", "");
      expect(() => openVault(d, "personal")).toThrow(/SAKLAZ_INSECURE_VAULT/);
      vi.unstubAllEnvs();
    }
    const { vault, wipe } = openVault(d, "personal", new FakeProtector());
    vault.set("k", Uint8Array.of(9));
    wipe();
    expect(existsSync(join(d, "kek.bin"))).toBe(true);
    expect(openVault(d, "personal", new FakeProtector()).vault.get("k")).toEqual(Uint8Array.of(9));
  });
});

describe("izinli komutlar", () => {
  it("salt okunur komutlar çalışır; listede olmayan her şey NOT_ALLOWED", async () => {
    for (const t of ["sistem", "SİSTEM BİLGİSİ", "disk", "ağ", "ip", "çalışma süresi", "ping", "işlemler", "yardım"]) {
      const r = await runCommand(t);
      expect(r.ok, t).toBe(true);
      expect(r.summary.length).toBeGreaterThan(0);
    }
    expect((await runCommand("sistem")).summary).toContain("Bilgisayar:");
    for (const t of ["del /s C:\\", "powershell -c whoami", "sistem; shutdown", "", "rm -rf /"]) {
      const r = await runCommand(t);
      expect(r.ok).toBe(false);
      expect(r.code).toBe("NOT_ALLOWED");
      expect(r.name).toBe("?");
    }
    expect(helpText()).toContain("sistem");
    expect(allowedCommandNames()).toContain("yardım");
  });
});

describe("servis yardımcıları", () => {
  it("profil, klasör ve relay adresi doğrulaması", () => {
    expect(isProfile("personal") && isProfile("business") && !isProfile("x")).toBe(true);
    expect(profileDir("business", { SAKLAZ_AGENT_HOME: "/h" })).toBe(join("/h", "agent-business"));
    expect(profileDir("personal", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32")).toBe("C:\\Users\\a\\AppData\\Local\\SAKLAZ\\agent-personal");
    expect(() => profileDir("personal", {}, "win32")).toThrow();
    expect(profileDir("personal", {}, "linux")).toContain(".saklaz");
    expect(validateRelayUrl("wss://relay.ornek.com/v1/connect", false)).toBe("wss://relay.ornek.com");
    expect(() => validateRelayUrl("ws://10.0.0.2:8080", false)).toThrow("RELAY_URL_INSECURE");
    expect(validateRelayUrl("ws://10.0.0.2:8080", true)).toBe("ws://10.0.0.2:8080");
    expect(() => validateRelayUrl("https://x", true)).toThrow("RELAY_URL_INVALID");
    expect(() => validateRelayUrl("::", true)).toThrow("RELAY_URL_INVALID");
  });

  it("günlük dosyası: JSON satırları, döndürme", () => {
    const d = tmp();
    const log = createFileLogger(d, false);
    log("info", "olay", { a: 1 });
    const line = JSON.parse(readFileSync(join(d, "agent.log"), "utf8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ level: "info", event: "olay", a: 1 });
    writeFileSync(join(d, "agent.log"), Buffer.alloc(5 * 1024 * 1024 + 10));
    log("warn", "dondur");
    expect(existsSync(join(d, "agent.log.1"))).toBe(true);
  });
});

describe("AgentService + telefon istemcisi (relay'siz)", () => {
  function service(dir = tmp()) {
    return new AgentService({ profile: "personal", dir, protector: new FakeProtector(), log: noLog, allowInsecureRelay: true });
  }

  it("yapılandırılmamış/girişsiz servis; giriş; eşleştirme; komut; yeniden açılış", async () => {
    const dir = tmp();
    const svc = service(dir);
    expect(svc.config).toBeUndefined();
    expect(svc.isLoggedIn).toBe(false);
    expect(svc.isReady).toBe(false);
    expect(() => svc.connect()).toThrow("NOT_CONFIGURED");
    await expect(svc.login("a@b.co", "p", "123456")).rejects.toThrow("NOT_CONFIGURED");
    svc.configure("ws://127.0.0.1:9", "  Şirket bilgisayarı  ");
    expect(svc.config?.label).toBe("Şirket bilgisayarı");
    expect(() => svc.connect()).toThrow("NOT_LOGGED_IN");

    // Giriş: relay HTTP uçları sahte fetch ile; yenileme token'ı kasaya yazılır
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        status: url.endsWith("/v1/devices") ? 201 : 200,
        json: () => Promise.resolve(url.endsWith("/login") ? { accessToken: "test-erisim", refreshToken: "test-yenileme-yer-tutucu", accountId: "acc" } : { ok: true }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await svc.login("a@b.co", "p", "123456");
    expect(svc.isLoggedIn).toBe(true);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["http://127.0.0.1:9/v1/auth/login", "http://127.0.0.1:9/v1/devices"]);

    // Relay'siz eşleştirme: çerçeveler doğrudan aktarılır
    const phone = PhoneClient.createWorkspace({ label: "Telefon" });
    const inbox: InnerMessage[] = [];
    const toAgent = (outs: WireOut[]) => {
      const r = svc.core.processIncoming(outs.map((o) => ({ from: phone.id, kind: o.kind, ct: o.ct })));
      return r;
    };
    const toPhone = (outs: WireOut[]) => {
      const r = phone.receive(outs.map((o) => ({ from: svc.core.deviceId, kind: o.kind, ct: o.ct })));
      inbox.push(...r.messages);
      return r.replies;
    };
    const qr = decodePairingQr(svc.startPairing());
    expect(qr.relay).toBe("ws://127.0.0.1:9");
    toAgent([phone.startPairing(qr, "Şirket bilgisayarı")]);
    expect(await svc.waitForSas(1000)).toBe(phone.sasFor(qr));
    // SAS onayı: pair-ok bu testte relay olmadığından doğrudan çekirdekten alınır
    const ok = svc.core.confirmPairing(true);
    expect(ok).toBeDefined();
    const link = toPhone(ok ? [ok] : []);
    let r = toAgent(link);
    let replies = toPhone(r.out);
    while (replies.length) {
      r = toAgent(replies);
      replies = toPhone(r.out);
    }
    await svc.waitLinked(1000);
    expect(phone.computers()).toEqual([{ deviceId: svc.core.deviceId, label: "Şirket bilgisayarı", role: "owner" }]);
    expect(svc.confirmPairing(true)).toBe(false); // bekleyen eşleştirme yok

    // Komut: çekirdek "received" üretir; servis komutu çalıştırıp sonucu relay istemcisi üzerinden gönderir
    // (burada relay yok → sonuç gönderilmez ama çökme olmaz).
    const res = toAgent(phone.send(svc.core.deviceId, "cmd.create", { taskId: "01934b6e-0000-7000-8000-0000000000a1", text: "ping" }));
    expect(res.accepted.map((m) => m.hdr.type)).toEqual(["cmd.create"]);
    toPhone(res.out);
    expect(inbox.some((m) => m.hdr.type === "task.event")).toBe(true);
    await new Promise((x) => setTimeout(x, 20));

    await expect(svc.waitForSas(50)).rejects.toThrow("PAIRING_TIMEOUT");
    const id = svc.core.deviceId;
    svc.close();
    const again = service(dir);
    expect(again.core.deviceId).toBe(id);
    expect(again.isLoggedIn).toBe(true);
    expect(again.config?.relayUrl).toBe("ws://127.0.0.1:9");
    await again.waitLinked(100);
    again.close();
    // Kişisel ve kurumsal profil aynı klasör kökünde bile ayrı kimlik kullanır
    const biz = new AgentService({ profile: "business", dir: join(dir, "..", "biz"), protector: new FakeProtector(), log: noLog });
    expect(biz.core.deviceId).not.toBe(id);
    await expect(biz.waitLinked(50)).rejects.toThrow("LINK_TIMEOUT");
    biz.close();
    dirs.push(join(dir, "..", "biz"));
  });
});
