/**
 * @saklaz/win-keyprotect testleri (Sprint 3 A3).
 *
 * • Her platformda: sarmalayıcının girdi denetimi ve hata eşlemesi (sahte yerel modülle);
 *   Windows dışında UNSUPPORTED_PLATFORM (güvensiz geri düşüş yok).
 * • Yalnızca Windows'ta: GERÇEK DPAPI. Windows'ta yerel modül yoksa bekçi test KIRMIZI olur;
 *   gerçek testler sessizce atlanamaz.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAvailable, KeyProtectError, loadNative, MAX_DATA_BYTES, MAX_ENTROPY_BYTES, wrapNative, type NativeKeyProtect } from "../src/index.js";

const IS_WIN = process.platform === "win32";
const ENT = new TextEncoder().encode("SAKLAZ-v1/test-entropy");

function expectCode(fn: () => unknown, code: string): KeyProtectError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(KeyProtectError);
    expect((e as KeyProtectError).code).toBe(code);
    return e as KeyProtectError;
  }
  throw new Error(`${code} bekleniyordu`);
}

describe("sarmalayıcı (her platform, sahte yerel modül)", () => {
  const fake: NativeKeyProtect = {
    protect: (d) => Uint8Array.from([...d].reverse()),
    unprotect: (b, e) => {
      if (e.length === 0) throw Object.assign(new Error("UNPROTECT_FAILED (win32=13) gizli-ayrinti"), { code: "UNPROTECT_FAILED" });
      return Uint8Array.from([...b].reverse());
    },
    userSid: () => "S-1-5-21-1-2-3-1001",
    machineGuid: () => "AABBCCDD-0000-1111-2222-333344445555",
  };
  const w = wrapNative(fake);

  it("gidiş-dönüş ve MachineGuid küçük harfe çevrilir", () => {
    const d = new Uint8Array([1, 2, 3]);
    expect([...w.unprotect(w.protect(d, ENT), ENT)]).toEqual([1, 2, 3]);
    expect(w.machineGuid()).toBe("aabbccdd-0000-1111-2222-333344445555");
    expect(w.userSid()).toBe("S-1-5-21-1-2-3-1001");
  });

  it("girdi denetimi: boş veri, sınırı aşan veri/entropy, Uint8Array olmayan değer", () => {
    expectCode(() => w.protect(new Uint8Array(0), ENT), "INVALID_ARGUMENT");
    expectCode(() => w.protect(new Uint8Array(MAX_DATA_BYTES + 1), ENT), "INVALID_ARGUMENT");
    expectCode(() => w.protect(new Uint8Array(1), new Uint8Array(MAX_ENTROPY_BYTES + 1)), "INVALID_ARGUMENT");
    expectCode(() => w.unprotect("metin" as unknown as Uint8Array, ENT), "INVALID_ARGUMENT");
    expect(w.protect(new Uint8Array(1), new Uint8Array(0)).length).toBe(1); // boş entropy izinli
  });

  it("yerel hata koda ve Win32 numarasına çevrilir; yerel mesajın geri kalanı iletilmez", () => {
    const e = expectCode(() => w.unprotect(new Uint8Array([1]), new Uint8Array(0)), "UNPROTECT_FAILED");
    expect(e.win32Error).toBe(13);
    expect(e.message).not.toContain("gizli-ayrinti");
    const odd = wrapNative({ ...fake, userSid: () => { throw new Error("tuhaf C:\\Users\\ad"); } });
    const e2 = expectCode(() => odd.userSid(), "INTERNAL");
    expect(e2.message).toBe("INTERNAL");
  });

  it("Windows dışında UNSUPPORTED_PLATFORM; güvensiz geri düşüş yok", () => {
    expectCode(() => loadNative("linux"), "UNSUPPORTED_PLATFORM");
    expectCode(() => loadNative("darwin"), "UNSUPPORTED_PLATFORM");
    expect(isAvailable("linux")).toBe(false);
  });

  it.runIf(!IS_WIN)("Windows kabul edilse bile derlenmiş modül yoksa NATIVE_MODULE_MISSING (sessiz geri düşüş yok)", () => {
    expectCode(() => loadNative("win32"), "NATIVE_MODULE_MISSING");
    expect(isAvailable("win32")).toBe(false);
  });
});

describe.runIf(IS_WIN)("GERÇEK DPAPI (yalnızca Windows)", () => {
  it("bekçi: Windows'ta yerel modül yüklenebilmeli (yoksa DPAPI testleri koşmuyor demektir)", () => {
    expect(() => loadNative()).not.toThrow();
    expect(isAvailable()).toBe(true);
  });

  it("koruma ve çözme: gidiş-dönüş; blob düz metni içermez; her korumada farklı blob", () => {
    const n = loadNative();
    const secret = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
    const a = n.protect(secret, ENT);
    const b = n.protect(secret, ENT);
    expect(Buffer.from(a).includes(Buffer.from(secret))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect([...n.unprotect(a, ENT)]).toEqual([...secret]);
    expect([...n.unprotect(b, ENT)]).toEqual([...secret]);
  });

  it("yanlış entropy ile çözme başarısız", () => {
    const n = loadNative();
    const blob = n.protect(new Uint8Array([9, 9, 9]), ENT);
    expectCode(() => n.unprotect(blob, new TextEncoder().encode("baska")), "UNPROTECT_FAILED");
    expectCode(() => n.unprotect(blob, new Uint8Array(0)), "UNPROTECT_FAILED");
  });

  it("değiştirilmiş blob reddedilir (baştan, ortadan, sondan tek bayt; kısaltma)", () => {
    const n = loadNative();
    const blob = n.protect(new Uint8Array(32).fill(7), ENT);
    for (const i of [0, Math.floor(blob.length / 2), blob.length - 1]) {
      const t = blob.slice();
      t[i] = (t[i] ?? 0) ^ 0x01;
      expect(() => n.unprotect(t, ENT)).toThrow(KeyProtectError);
    }
    expect(() => n.unprotect(blob.slice(0, blob.length - 4), ENT)).toThrow(KeyProtectError);
  });

  it("geçersiz girdiler yerel katmanda da reddedilir", () => {
    const n = loadNative();
    expectCode(() => n.protect(new Uint8Array(0), ENT), "INVALID_ARGUMENT");
    expectCode(() => n.unprotect(new Uint8Array(MAX_DATA_BYTES + 1), ENT), "INVALID_ARGUMENT");
  });

  it("kullanıcı SID'i ve MachineGuid biçimi doğru; yönetici yetkisi gerekmez", () => {
    const n = loadNative();
    expect(n.userSid()).toMatch(/^S-1-5-(18|19|20|21-\d+-\d+-\d+-\d+)$/);
    expect(n.machineGuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("yeniden başlatma: bir süreçte korunan veri, AYRI bir süreçte aynı kullanıcıyla çözülür", () => {
    const dir = mkdtempSync(join(tmpdir(), "saklaz-kp-"));
    const probe = join(fileURLToPath(import.meta.url), "..", "..", "scripts", "probe.mjs");
    try {
      const blob = join(dir, "blob.bin");
      const p = spawnSync(process.execPath, [probe, "protect", blob], { encoding: "utf8" });
      expect(p.status).toBe(0);
      const v = spawnSync(process.execPath, [probe, "verify", blob], { encoding: "utf8" });
      expect(v.status).toBe(0);
      expect((JSON.parse(v.stdout) as { ok: boolean }).ok).toBe(true);
      // Düz metin hiçbir dosyada veya çıktıda yok (yalnızca özet yazılır).
      expect(readFileSync(`${blob}.sha256`, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
