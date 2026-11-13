/**
 * Açılış denetimleri (Sprint 3 A2). Hepsi "başlama veya hiç başlama" ilkesine göre çalışır:
 * bir denetim başarısızsa relay dinlemeye başlamaz ve süreç sıfırdan farklı bir kodla çıkar.
 * Konteyner yeniden başlatma politikası süreci yeniden dener; hata günlükte görünür.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { SignJWT, importPKCS8, importSPKI, jwtVerify, type CryptoKey, type KeyObject } from "jose";
import { pingDb, type Pool } from "./db.js";

export class StartupError extends Error {
  constructor(
    readonly code: "DB_UNREACHABLE" | "JWT_KEY_INVALID" | "JWT_KEYPAIR_MISMATCH" | "MFA_KEY_MISMATCH",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "StartupError";
  }
}

/**
 * Veritabanı hazır olana kadar üstel geri çekilmeyle bekler (konteynerler aynı anda başlar).
 * Hata mesajları bağlantı adresini veya parolayı içermez.
 */
export async function waitForDb(
  pool: Pool,
  o: { maxWaitMs: number; onRetry?: (attempt: number, delayMs: number) => void; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + o.maxWaitMs;
  let delay = 250;
  for (let attempt = 1; ; attempt++) {
    if (await pingDb(pool, 3_000)) return;
    if (Date.now() + delay > deadline) throw new StartupError("DB_UNREACHABLE", `veritabanına ${attempt} denemede bağlanılamadı`);
    o.onRetry?.(attempt, delay);
    await sleep(delay);
    delay = Math.min(delay * 2, 5_000);
  }
}

/** JWT anahtarlarını içe aktarır ve birbirine ait olduklarını imzala-doğrula ile denetler. */
export async function loadJwtKeys(
  privatePem: string,
  publicPem: string,
  issuer: string,
): Promise<{ privateKey: CryptoKey | KeyObject; publicKey: CryptoKey | KeyObject }> {
  let privateKey: CryptoKey | KeyObject;
  let publicKey: CryptoKey | KeyObject;
  try {
    privateKey = await importPKCS8(privatePem, "EdDSA");
    publicKey = await importSPKI(publicPem, "EdDSA");
  } catch {
    // jose'nin hata mesajı anahtar içeriğinden parça içerebilir; iletilmez.
    throw new StartupError("JWT_KEY_INVALID", "JWT anahtarları Ed25519 PKCS#8 / SPKI PEM biçiminde değil");
  }
  try {
    const probe = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA" }).setIssuer(issuer).setSubject("startup-probe").sign(privateKey);
    await jwtVerify(probe, publicKey, { issuer, algorithms: ["EdDSA"] });
  } catch {
    throw new StartupError("JWT_KEYPAIR_MISMATCH", "JWT özel ve açık anahtarı aynı çifte ait değil");
  }
  return { privateKey, publicKey };
}

const CHECK_LABEL = "SAKLAZ-v1/mfa-key-check";

/** MFA anahtarından türetilen, geri çevrilemeyen denetim değeri. Anahtarın kendisi saklanmaz. */
export function mfaKeyCheck(mfaKey: Uint8Array): string {
  return createHmac("sha256", mfaKey).update(CHECK_LABEL).digest("hex");
}

/**
 * MFA şifreleme anahtarının bu veritabanıyla uyumlu olduğunu denetler.
 *
 * • Denetim değeri kayıtlıysa: eşit olmalı, değilse MFA_KEY_MISMATCH.
 * • Kayıt yoksa (ilk kurulum veya A2 öncesi kurulum): hesap varsa, anahtarın gerçekten en az bir
 *   hesabın TOTP sırrını çözebildiği doğrulanır; sonra değer kaydedilir.
 *
 * Yanlış anahtarla başlatılan bir relay, kullanıcı girişlerini sessizce bozmak yerine hiç başlamaz.
 */
export async function ensureMfaKey(pool: Pool, mfaKey: Uint8Array, canDecrypt: (blob: Buffer) => boolean): Promise<"verified" | "initialized"> {
  const expected = mfaKeyCheck(mfaKey);
  const r = await pool.query<{ value: string }>("SELECT value FROM relay_meta WHERE key = 'mfa_key_check'");
  const stored = r.rows[0]?.value;
  if (stored !== undefined) {
    const a = Buffer.from(stored, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new StartupError("MFA_KEY_MISMATCH", "MFA anahtarı bu veritabanında kullanılan anahtar değil");
    }
    return "verified";
  }
  const sample = await pool.query<{ totp_secret_enc: Buffer }>("SELECT totp_secret_enc FROM accounts ORDER BY created_at LIMIT 1");
  const blob = sample.rows[0]?.totp_secret_enc;
  if (blob && !canDecrypt(blob)) {
    throw new StartupError("MFA_KEY_MISMATCH", "MFA anahtarı mevcut hesapların TOTP sırlarını çözemiyor");
  }
  // Eşzamanlı ilk açılışta iki süreç aynı değeri yazar; çakışma zararsızdır.
  await pool.query("INSERT INTO relay_meta (key, value) VALUES ('mfa_key_check', $1) ON CONFLICT (key) DO NOTHING", [expected]);
  // Yarışı kaybeden süreç, kazananın yazdığı değeri yeniden doğrular (farklıysa hata fırlatır).
  await ensureMfaKey(pool, mfaKey, canDecrypt);
  return "initialized";
}
