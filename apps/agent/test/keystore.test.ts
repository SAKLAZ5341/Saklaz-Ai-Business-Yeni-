/**
 * Sprint 3 A3 — korumalı anahtar dosyası (ProtectedKeyStore) ve DPAPI koruyucusu.
 *
 * Linux ve Windows'ta: sahte koruyucuyla biçim, bağlama, bozulma ve atomik kayıt testleri.
 * Yalnızca Windows'ta: GERÇEK DPAPI ile aynı senaryolar (@saklaz/win-keyprotect derlenmiş olmalı).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concat, initCrypto, toHex } from "@saklaz/crypto";
import type { NativeKeyProtect } from "@saklaz/win-keyprotect";
import { bindingHash, defaultKeyPath, DpapiUserProtector, KEK_BYTES, KeyProtectionError, ProtectedKeyStore, type KeyProtector } from "../src/index.js";
import { FakeProtector } from "./fake-protector.js";

const IS_WIN = process.platform === "win32";
beforeAll(initCrypto);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function keyPath(): string {
  const d = mkdtempSync(join(tmpdir(), "saklaz-kek-"));
  dirs.push(d);
  return join(d, "ws", "kek.bin");
}

function expectCode(fn: () => unknown, code: string): KeyProtectionError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(KeyProtectionError);
    expect((e as KeyProtectionError).code).toBe(code);
    return e as KeyProtectionError;
  }
  throw new Error(`${code} bekleniyordu`);
}

/** Aynı senaryolar hem sahte hem gerçek koruyucuyla koşar. */
function suite(name: string, make: () => KeyProtector) {
  describe(name, () => {
    it("oluştur → yeniden aç: aynı 32 baytlık KEK; dosyada KEK düz metin olarak yok", () => {
      const p = keyPath();
      const kek = ProtectedKeyStore.create(p, make());
      expect(kek.length).toBe(KEK_BYTES);
      const again = ProtectedKeyStore.load(p, make()); // yeni koruyucu örneği = yeniden başlatma
      expect(toHex(again)).toBe(toHex(kek));
      const file = readFileSync(p);
      expect(file.includes(Buffer.from(kek))).toBe(false);
      expect(file.toString("latin1").includes(toHex(kek))).toBe(false);
      expect(file.subarray(0, 4).toString()).toBe("SKK1");
    });

    it("var olan anahtar dosyasının üzerine yazılmaz (KEY_EXISTS); dosya değişmez", () => {
      const p = keyPath();
      ProtectedKeyStore.create(p, make());
      const before = readFileSync(p);
      expectCode(() => ProtectedKeyStore.create(p, make()), "KEY_EXISTS");
      expect(readFileSync(p).equals(before)).toBe(true);
      expect(readdirSync(join(p, "..")).filter((f) => f.includes(".tmp-"))).toEqual([]);
    });

    it("openOrCreate: ilk çağrı oluşturur, ikincisi aynı anahtarı açar", () => {
      const p = keyPath();
      const a = ProtectedKeyStore.openOrCreate(p, make());
      const b = ProtectedKeyStore.openOrCreate(p, make());
      expect([a.created, b.created]).toEqual([true, false]);
      expect(toHex(b.kek)).toBe(toHex(a.kek));
    });

    it("bozuk dosya: her başlık baytı ve blob baytı değiştirildiğinde reddedilir; dosya değiştirilmez", () => {
      const p = keyPath();
      ProtectedKeyStore.create(p, make());
      const orig = readFileSync(p);
      const codes = new Set<string>();
      for (let i = 0; i < orig.length; i++) {
        const t = Buffer.from(orig);
        t[i] = (t[i] ?? 0) ^ 0x01;
        writeFileSync(p, t);
        try {
          ProtectedKeyStore.load(p, make());
          throw new Error(`bayt ${String(i)} değiştiği halde açıldı`);
        } catch (e) {
          expect(e).toBeInstanceOf(KeyProtectionError);
          codes.add((e as KeyProtectionError).code);
        }
        expect(readFileSync(p).equals(t)).toBe(true); // yükleme dosyaya dokunmadı
      }
      expect([...codes].every((c) => ["KEY_FORMAT", "KEY_VERSION", "PROTECTOR_MISMATCH", "BINDING_MISMATCH", "UNWRAP_FAILED", "KEY_INTEGRITY"].includes(c))).toBe(true);
      expect(codes.has("KEY_INTEGRITY")).toBe(true); // bütünlük etiketinin baytları
    });

    it("kısaltılmış, boş, uzatılmış ve olmayan dosya", () => {
      const p = keyPath();
      expectCode(() => ProtectedKeyStore.load(p, make()), "KEY_NOT_FOUND");
      ProtectedKeyStore.create(p, make());
      const orig = readFileSync(p);
      for (const t of [Buffer.alloc(0), orig.subarray(0, 10), orig.subarray(0, orig.length - 1), Buffer.concat([orig, Buffer.from([0])])]) {
        writeFileSync(p, t);
        expectCode(() => ProtectedKeyStore.load(p, make()), "KEY_FORMAT");
      }
      writeFileSync(p, Buffer.alloc(70_000));
      expectCode(() => ProtectedKeyStore.load(p, make()), "KEY_FORMAT");
    });
  });
}

suite("ProtectedKeyStore — sahte koruyucu (her platform)", () => new FakeProtector());

describe("bağlama ve izolasyon (sahte koruyucu)", () => {
  it("başka kullanıcı: BINDING_MISMATCH; bağlam aynı ama ana anahtar farklı (parola sıfırlama): UNWRAP_FAILED", () => {
    const p = keyPath();
    ProtectedKeyStore.create(p, new FakeProtector("kullanici-a"));
    expectCode(() => ProtectedKeyStore.load(p, new FakeProtector("kullanici-b")), "BINDING_MISMATCH");
    expectCode(() => ProtectedKeyStore.load(p, new FakeProtector("kullanici-a", undefined, "sifirlanmis")), "UNWRAP_FAILED");
  });

  it("başka makine (dolaşan profil): BINDING_MISMATCH", () => {
    const p = keyPath();
    ProtectedKeyStore.create(p, new FakeProtector("kullanici-a", "11111111-2222-3333-4444-555555555555"));
    expectCode(() => ProtectedKeyStore.load(p, new FakeProtector("kullanici-a", "99999999-2222-3333-4444-555555555555")), "BINDING_MISMATCH");
  });

  it("bağlam özeti uzunluk önekli (SID/GUID sınırı kaydırılarak çakışma üretilemez) ve GUID büyük/küçük harf duyarsız", () => {
    const a = bindingHash({ userSid: "S-1-5-21-1", machineGuid: "2abc" });
    const b = bindingHash({ userSid: "S-1-5-21-12", machineGuid: "abc" });
    expect(toHex(a)).not.toBe(toHex(b));
    expect(toHex(bindingHash({ userSid: "S", machineGuid: "AB" }))).toBe(toHex(bindingHash({ userSid: "S", machineGuid: "ab" })));
  });

  it("koruyucu hatası: KEK silinir, dosya oluşmaz; hata mesajında gizli değer yok", () => {
    const p = keyPath();
    const bad: KeyProtector = { kind: "test-fake", binding: () => ({ userSid: "S", machineGuid: "g" }), wrap: () => new Uint8Array(5000), unwrap: () => new Uint8Array(0) };
    expectCode(() => ProtectedKeyStore.create(p, bad), "PROTECT_FAILED");
    expect(existsSync(p)).toBe(false);
    // Koruyucu blob'u "kabul edip" yanlış uzunlukta veri döndürürse (bozuk koruyucu) KEY_FORMAT.
    const short: KeyProtector = { ...bad, wrap: () => new Uint8Array(10), unwrap: () => new Uint8Array(16) };
    ProtectedKeyStore.create(p, short);
    expectCode(() => ProtectedKeyStore.load(p, short), "KEY_FORMAT"); // 32 bayt değil
  });

  it("wrap hata fırlatırsa: KEK sıfırlanır, dosya ve geçici dosya oluşmaz, hata aynen iletilir", () => {
    const p = keyPath();
    let seen: Uint8Array | undefined;
    const throwing: KeyProtector = {
      kind: "test-fake",
      binding: () => ({ userSid: "S", machineGuid: "g" }),
      wrap: (k) => {
        seen = k;
        expect(k.some((b) => b !== 0)).toBe(true); // wrap çağrıldığında KEK doluydu
        throw new KeyProtectionError("PROTECT_FAILED", 5);
      },
      unwrap: () => new Uint8Array(0),
    };
    const e = expectCode(() => ProtectedKeyStore.create(p, throwing), "PROTECT_FAILED");
    expect(e.win32Error).toBe(5);
    expect(seen?.length).toBe(KEK_BYTES);
    expect(seen?.every((b) => b === 0)).toBe(true); // finally → wipe(kek)
    expect(existsSync(p)).toBe(false);
    expect(existsSync(join(p, ".."))).toBe(false); // yazma aşamasına hiç geçilmedi
  });

  it("KEK silme yolu: geçersiz blob boyutu ve yazma hatasında KEK sıfırlanır; başarıda KEK korunur", () => {
    const capture = (blob: Uint8Array) => {
      const s: { kek?: Uint8Array } = {};
      const prot: KeyProtector = {
        kind: "test-fake",
        binding: () => ({ userSid: "S", machineGuid: "g" }),
        wrap: (k) => { s.kek = k; return blob; },
        unwrap: () => new Uint8Array(0),
      };
      return { s, prot };
    };
    const big = capture(new Uint8Array(5000));
    expectCode(() => ProtectedKeyStore.create(keyPath(), big.prot), "PROTECT_FAILED");
    expect(big.s.kek?.every((b) => b === 0)).toBe(true);

    const p = keyPath();
    writeFileSync(join(p, ".."), "x"); // hedef klasör bir dosya → yazma hatası
    const wf = capture(new Uint8Array(10));
    expectCode(() => ProtectedKeyStore.create(p, wf.prot), "WRITE_FAILED");
    expect(wf.s.kek?.every((b) => b === 0)).toBe(true);

    const okc = capture(new Uint8Array(10));
    const kek = ProtectedKeyStore.create(keyPath(), okc.prot);
    expect(kek).toBe(okc.s.kek); // aynı tampon çağırana verilir
    expect(kek.some((b) => b !== 0)).toBe(true); // başarıda silinmez
  });

  it("koruyucu blob'daki bir değişikliği FARK ETMESE bile (DPAPI'nin denetlemediği başlık alanları) dosya reddedilir: KEY_INTEGRITY", () => {
    const p = keyPath();
    // Blob'un ilk 4 baytını yok sayan sahte koruyucu: Windows CI'da gerçek DPAPI'de görülen davranış.
    const inner = new FakeProtector();
    const lax: KeyProtector = {
      kind: "test-fake",
      binding: () => inner.binding(),
      wrap: (k, e) => concat(new Uint8Array(4), inner.wrap(k, e)),
      unwrap: (b, e) => inner.unwrap(b.subarray(4), e),
    };
    const kek = ProtectedKeyStore.create(p, lax);
    expect(toHex(ProtectedKeyStore.load(p, lax))).toBe(toHex(kek));
    const t = readFileSync(p);
    t[60] = (t[60] ?? 0) ^ 0xff; // blob'un "denetlenmeyen" alanı
    writeFileSync(p, t);
    expectCode(() => ProtectedKeyStore.load(p, lax), "KEY_INTEGRITY");
  });

  it("yazım hatası WRITE_FAILED olarak döner (hedef klasör bir dosya)", () => {
    const p = keyPath();
    writeFileSync(join(p, "..", "..", "engel"), "x");
    expectCode(() => ProtectedKeyStore.create(join(p, "..", "..", "engel", "kek.bin"), new FakeProtector()), "WRITE_FAILED");
  });

  it("varsayılan konum: %LOCALAPPDATA%\\SAKLAZ\\<çalışma alanı>\\kek.bin; yalnızca Windows; çalışma alanı kimliği doğrulanır", () => {
    expect(defaultKeyPath("ws_AAAAAAAAAAAAAAAA", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32")).toBe("C:\\Users\\a\\AppData\\Local\\SAKLAZ\\ws_AAAAAAAAAAAAAAAA\\kek.bin");
    expectCode(() => defaultKeyPath("ws_AAAAAAAAAAAAAAAA", {}, "linux"), "UNSUPPORTED_PLATFORM");
    expectCode(() => defaultKeyPath("ws_AAAAAAAAAAAAAAAA", {}, "win32"), "UNSUPPORTED_PLATFORM");
    expectCode(() => defaultKeyPath("..\\..\\Windows", { LOCALAPPDATA: "C:\\x" }, "win32"), "INVALID_ARGUMENT");
  });
});

describe("DpapiUserProtector (sahte yerel modülle, her platform)", () => {
  const native = (over: Partial<NativeKeyProtect> = {}): NativeKeyProtect => ({
    protect: (d) => Uint8Array.from(d, (x) => x ^ 0x5a),
    unprotect: (b) => Uint8Array.from(b, (x) => x ^ 0x5a),
    userSid: () => "S-1-5-21-1-2-3-1001",
    machineGuid: () => "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    ...over,
  });

  it("bağlam önbelleğe alınır ve GUID küçük harfe çevrilir; sarma/çözme yerel modüle gider", () => {
    let calls = 0;
    const p = new DpapiUserProtector(native({ userSid: () => (calls++, "S-1-5-21-1-2-3-1001") }));
    expect(p.binding()).toEqual({ userSid: "S-1-5-21-1-2-3-1001", machineGuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
    p.binding();
    expect(calls).toBe(1);
    expect([...p.unwrap(p.wrap(new Uint8Array([1, 2]), new Uint8Array(0)), new Uint8Array(0))]).toEqual([1, 2]);
  });

  it("yerel hatalar KeyProtectionError'a çevrilir (kod + Win32 numarası; mesaj sızmaz)", async () => {
    const { KeyProtectError } = await import("@saklaz/win-keyprotect");
    const p = new DpapiUserProtector(
      native({
        protect: () => { throw new KeyProtectError("PROTECT_FAILED", 87); },
        unprotect: () => { throw new KeyProtectError("UNPROTECT_FAILED", 13); },
        userSid: () => { throw new KeyProtectError("SYSTEM_QUERY_FAILED", 5); },
      }),
    );
    const e1 = expectCode(() => p.wrap(new Uint8Array(1), new Uint8Array(0)), "PROTECT_FAILED");
    expect(e1.win32Error).toBe(87);
    expect(expectCode(() => p.unwrap(new Uint8Array(1), new Uint8Array(0)), "UNWRAP_FAILED").win32Error).toBe(13);
    expectCode(() => p.binding(), "PROTECT_FAILED");
    const q = new DpapiUserProtector(native({ protect: () => { throw new KeyProtectError("INVALID_ARGUMENT"); }, unprotect: () => { throw new Error("C:\\gizli\\yol"); } }));
    expectCode(() => q.wrap(new Uint8Array(1), new Uint8Array(0)), "INVALID_ARGUMENT");
    expect(expectCode(() => q.unwrap(new Uint8Array(1), new Uint8Array(0)), "UNWRAP_FAILED").message).toBe("UNWRAP_FAILED");
  });

  it.runIf(!IS_WIN)("Windows dışında gerçek koruyucu OLUŞTURULMAZ (UNSUPPORTED_PLATFORM; güvensiz geri düşüş yok)", () => {
    expectCode(() => new DpapiUserProtector(), "UNSUPPORTED_PLATFORM");
  });
});

describe.runIf(IS_WIN)("GERÇEK DPAPI (yalnızca Windows)", () => {
  it("bekçi: gerçek koruyucu oluşturulabilmeli (yoksa Windows'ta DPAPI testleri koşmuyor demektir)", () => {
    expect(() => new DpapiUserProtector()).not.toThrow();
    const b = new DpapiUserProtector().binding();
    expect(b.userSid).toMatch(/^S-1-5-/);
    expect(b.machineGuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  suite("ProtectedKeyStore — gerçek DPAPI", () => new DpapiUserProtector());

  it("gerçek DPAPI blob'u, sahte bir 'başka makine' bağlamıyla açılamaz (BINDING_MISMATCH)", () => {
    const p = keyPath();
    const real = new DpapiUserProtector();
    ProtectedKeyStore.create(p, real);
    const otherMachine: KeyProtector = { kind: "dpapi-user", binding: () => ({ ...real.binding(), machineGuid: "00000000-0000-0000-0000-000000000000" }), wrap: (k, e) => real.wrap(k, e), unwrap: (b, e) => real.unwrap(b, e) };
    expectCode(() => ProtectedKeyStore.load(p, otherMachine), "BINDING_MISMATCH");
  });
});
