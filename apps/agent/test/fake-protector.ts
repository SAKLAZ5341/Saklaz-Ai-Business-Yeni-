/**
 * YALNIZCA TEST: DPAPI'nin anlamını taklit eden sahte koruyucu (Sprint 3 A3).
 *
 * • Her "kullanıcı" + "makine" için ayrı bir sır vardır: başka bir kullanıcının sahte koruyucusu
 *   blob'u ÇÖZEMEZ (DPAPI kullanıcı izolasyonu).
 * • Entropy, AES-GCM'in ilişkili verisidir: yanlış entropy → UNWRAP_FAILED.
 * • "parola sıfırlama" benzetimi: aynı bağlam, farklı sır → UNWRAP_FAILED.
 * Üretim kodundan içe aktarılamaz (test klasöründe; tools/ci/check-boundaries.mjs).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { KeyProtectionError, type KeyProtector, type ProtectorBinding } from "../src/index.js";

export class FakeProtector implements KeyProtector {
  readonly kind = "test-fake" as const;
  private readonly key: Buffer;
  wrapCalls = 0;
  unwrapCalls = 0;

  constructor(
    readonly user = "kullanici-a",
    readonly machine = "11111111-2222-3333-4444-555555555555",
    /** Aynı kullanıcı için farklı bir değer = DPAPI ana anahtarının kaybı (yönetici parola sıfırlaması). */
    readonly masterSecret = "ana-anahtar-1",
  ) {
    this.key = createHash("sha256").update(`fake-dpapi|${user}|${machine}|${masterSecret}`).digest();
  }

  binding(): ProtectorBinding {
    return { userSid: `S-1-5-21-100-200-300-${this.user}`, machineGuid: this.machine };
  }

  wrap(kek: Uint8Array, entropy: Uint8Array): Uint8Array {
    this.wrapCalls++;
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(entropy);
    const ct = Buffer.concat([c.update(kek), c.final()]);
    return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), ct]));
  }

  unwrap(blob: Uint8Array, entropy: Uint8Array): Uint8Array {
    this.unwrapCalls++;
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
