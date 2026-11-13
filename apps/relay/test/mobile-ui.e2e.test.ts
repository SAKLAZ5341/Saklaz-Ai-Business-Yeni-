/**
 * Mobil arayüz uçtan uca (MVP alfa): derlenmiş arayüz (apps/mobile/web/dist/index.html) gerçek
 * Chromium'da çalışır; kabuk köprüsü test tarafından sağlanır (bellek içi depo + Node HTTP).
 * Gerçek relay + PostgreSQL + ajan servisi ile: hesap → giriş → eşleştirme (SAS) → komut → sonuç →
 * yerel AI sohbeti → uygulama yeniden açılışı.
 *
 * Gereken: PostgreSQL, Playwright + Chromium ve önceden derlenmiş arayüz. Biri yoksa test ATLANIR
 * (CI'da Playwright kurulu değildir; bu test geliştirme ortamında koşulur ve sonucu raporlanır).
 * Flutter kabuğunun kendisi (Keystore, kamera) burada SINANMAZ.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "jose";
import { initCrypto } from "@saklaz/crypto";
import { AgentService, KeyProtectionError, type KeyProtector } from "@saklaz/agent";
import { Accounts, buildRelay, createPool, migrate, RecordingPush, totp, type Pool } from "../src/index.js";
import { pgAvailable, startPg, type TestPg } from "./pg.js";

const UI = new URL("../../mobile/web/dist/index.html", import.meta.url).pathname;
// Tür bilgisi playwright-core'dan; çalışma zamanında ortamdaki "playwright" (önceden kurulu Chromium ile) kullanılır.
type PW = typeof import("playwright-core");
let pw: PW | undefined;
try {
  pw = createRequire(import.meta.url)("playwright") as PW;
} catch {
  pw = undefined;
}
const READY = pgAvailable() && !!pw && existsSync(UI);
const SHOTS = process.env["SAKLAZ_UI_SHOTS"];

class TestProtector implements KeyProtector {
  readonly kind = "test-fake" as const;
  private readonly key = createHash("sha256").update("ui-e2e").digest();
  binding() {
    return { userSid: "S-1-5-21-9-9-9-1001", machineGuid: "11111111-2222-3333-4444-555555555555" };
  }
  wrap(kek: Uint8Array, entropy: Uint8Array): Uint8Array {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(entropy);
    const ct = Buffer.concat([c.update(kek), c.final()]);
    return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), ct]));
  }
  unwrap(blob: Uint8Array, entropy: Uint8Array): Uint8Array {
    try {
      const b = Buffer.from(blob);
      const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
      d.setAAD(entropy);
      d.setAuthTag(b.subarray(12, 28));
      return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()]));
    } catch {
      throw new KeyProtectionError("UNWRAP_FAILED");
    }
  }
}

function b32decode(b32: string): Uint8Array {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let val = 0;
  const out: number[] = [];
  for (const ch of b32) {
    val = (val << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

describe.skipIf(!READY)("mobil arayüz + relay + ajan (Chromium)", () => {
  let pgi: TestPg;
  let pool: Pool;
  let relayUrl: string;
  let closeRelay: () => Promise<void>;
  let ai: Server;
  let aiUrl: string;
  const aiRequests: unknown[] = [];
  let offset = 0;
  const now = () => Date.now() + offset;
  const dirs: string[] = [];

  beforeAll(async () => {
    await initCrypto();
    pgi = await startPg();
    pool = createPool(pgi.url);
    await migrate(pool);
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const accounts = new Accounts(pool, { jwtPrivateKey: privateKey, jwtPublicKey: publicKey, mfaKey: randomBytes(32), issuer: "saklaz-ui", now });
    const { app } = buildRelay({ pool, accounts, relayId: "relay-ui", push: new RecordingPush(), authRatePerMinute: 1000 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const a = app.server.address();
    if (!a || typeof a === "string") throw new Error("adres");
    relayUrl = `ws://127.0.0.1:${String(a.port)}`;
    closeRelay = () => app.close();
    // Sahte "yerel AI" (OpenAI uyumlu /v1/chat/completions)
    ai = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        aiRequests.push(JSON.parse(body) as unknown);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "Yerel AI yanıtı: plan hazır." } }] }));
      });
    });
    await new Promise<void>((r) => ai.listen(0, "127.0.0.1", r));
    const ad = ai.address();
    if (!ad || typeof ad === "string") throw new Error("adres");
    aiUrl = `http://127.0.0.1:${String(ad.port)}/v1`;
  });

  afterAll(async () => {
    ai.close();
    await closeRelay();
    await pool.end();
    await pgi.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("hesap → giriş → eşleştirme → komut → AI → yeniden açılış", async () => {
    if (!pw) return;
    const storage = new Map<string, string>();
    const browser = await pw.chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    await ctx.exposeBinding("__th_get", (_s, k: string) => storage.get(k) ?? null);
    await ctx.exposeBinding("__th_set", (_s, k: string, v: string) => void storage.set(k, v));
    await ctx.exposeBinding("__th_remove", (_s, k: string) => void storage.delete(k));
    await ctx.exposeBinding("__th_http", async (_s, url: string, method: string, headers: Record<string, string>, body: string | null) => {
      const r = await fetch(url, { method, headers, ...(body !== null ? { body } : {}) });
      return { status: r.status, body: await r.text() };
    });
    await ctx.addInitScript(() => {
      const w = (globalThis as unknown) as Record<string, (...a: unknown[]) => Promise<unknown>> & { __saklazTestHost?: unknown };
      w.__saklazTestHost = {
        kind: "android",
        get: (k: string) => w["__th_get"]?.(k),
        set: (k: string, v: string) => w["__th_set"]?.(k, v),
        remove: (k: string) => w["__th_remove"]?.(k),
        http: (u: string, m: string, h: Record<string, string>, b?: string) => w["__th_http"]?.(u, m, h, b ?? null),
        scanQr: () => Promise.resolve(null),
      };
    });
    let agent: AgentService | undefined;
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const shot = async (name: string) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };
    try {
      await page.goto(`file://${UI}`);
      // 1) Hesap oluştur
      await page.fill("#pname", "Ev");
      await page.fill("#relay", relayUrl);
      await page.check("#insecure");
      await page.click("button:text-is('Yeni hesap')");
      await page.fill("#email", "ui@ornek.com.tr");
      await page.fill("#pw", "uzun-ve-guclu-parola-1");
      await page.click("#obgo");
      const secretText = (await page.locator("#obmsg pre").textContent({ timeout: 10_000 })) ?? "";
      const secret = b32decode(secretText.replace(/\s/g, ""));
      // 2) Giriş (TOTP)
      await page.click("button:text-is('Giriş')");
      await page.fill("#pw", "uzun-ve-guclu-parola-1");
      offset += 31_000;
      await page.fill("#code", totp(secret, now()));
      await page.click("#obgo");
      await page.waitForSelector("nav", { timeout: 15_000 });
      await page.waitForSelector("#relaydot.on", { timeout: 15_000 });
      expect(await page.textContent("header")).toContain("Kişisel · Ev");
      await shot("1-cihazlar-bos");

      // 3) Bilgisayar: kurulum + giriş + bağlantı + eşleştirme kodu
      const dir = mkdtempSync(join(tmpdir(), "saklaz-ui-agent-"));
      dirs.push(dir);
      agent = new AgentService({ profile: "personal", dir, protector: new TestProtector(), log: () => undefined, allowInsecureRelay: true });
      agent.configure(relayUrl, "Şirket bilgisayarı");
      offset += 31_000;
      await agent.login("ui@ornek.com.tr", "uzun-ve-guclu-parola-1", totp(secret, now()));
      await agent.connect().waitReady(10_000);
      const code = agent.startPairing();

      await page.fill("#plabel", "Şirket bilgisayarı");
      await page.fill("#pcode", code);
      await page.click("button:text-is('Eşleştir')");
      const uiSas = ((await page.locator(".sas").textContent({ timeout: 10_000 })) ?? "").trim();
      expect(uiSas).toBe(await agent.waitForSas(10_000));
      await shot("2-sas");
      expect(agent.confirmPairing(true)).toBe(true);
      await page.waitForSelector("text=eklendi", { timeout: 10_000 });
      await agent.waitLinked(10_000);

      // 4) Komut ve sonuç
      await page.click("nav >> text=Komut");
      await page.click(".quick >> text=sistem");
      await page.waitForSelector("pre:has-text('Bilgisayar:')", { timeout: 15_000 });
      await page.fill("#cmdtext", "format c:");
      await page.click("button:text-is('Gönder')");
      await page.waitForSelector("pre:has-text('izinli değil')", { timeout: 15_000 });
      await shot("3-komut-sonucu");

      // 5) AI: yerel sağlayıcı
      await page.click("nav >> text=Ayarlar");
      await page.selectOption("#aiprov", "local");
      await page.fill("#aimodel", "llama3.1");
      await page.fill("#ailocal", aiUrl);
      await page.click(".card:has(h2:text('Yapay zekâ')) >> text=Kaydet");
      await page.click("nav >> text=AI");
      await page.click(".tabs2 >> text=Günlük plan");
      await page.fill("#aitext", "Yarın 9'da toplantı, 14'te tedarikçi görüşmesi");
      await page.click("button:text-is('Gönder')");
      await page.waitForSelector("text=Yerel AI yanıtı: plan hazır.", { timeout: 10_000 });
      expect(JSON.stringify(aiRequests.at(-1))).toContain("günlük plan");
      await shot("4-ai");
      // OpenAI seçili ama anahtar yok → sahte yanıt yok, açık hata
      await page.click("nav >> text=Ayarlar");
      await page.selectOption("#aiprov", "openai");
      await page.click(".card:has(h2:text('Yapay zekâ')) >> text=Kaydet");
      await page.click("nav >> text=AI");
      await page.fill("#aitext", "merhaba");
      await page.click("button:text-is('Gönder')");
      await page.waitForSelector("text=API anahtarı girilmemiş", { timeout: 5_000 });

      // 6) Not / görev
      await page.click("nav >> text=Not/Görev");
      await page.fill("#todo", "Teklifleri karşılaştır");
      await page.click("button:text-is('Ekle')");
      await page.waitForSelector("text=Teklifleri karşılaştır");

      // 7) Uygulamanın yeniden açılması: kimlik ve bilgisayar listesi güvenli depodan gelir
      await page.reload();
      await page.waitForSelector("text=Şirket bilgisayarı", { timeout: 15_000 });
      await page.waitForSelector("#relaydot.on", { timeout: 15_000 });
      await page.click("nav >> text=Komut");
      await page.click(".quick >> text=ping");
      await page.waitForSelector("pre:has-text('pong')", { timeout: 15_000 });
      await page.click("nav >> text=Cihazlar");
      await shot("5-cihazlar");

      // Depoda düz metin parola yok; gizli değerler yalnızca kabuk deposunda
      const all = [...storage.values()].join("\n");
      expect(all).not.toContain("uzun-ve-guclu-parola-1");
      expect(errors).toEqual([]);
    } finally {
      agent?.close();
      await browser.close();
    }
  }, 120_000);
});
