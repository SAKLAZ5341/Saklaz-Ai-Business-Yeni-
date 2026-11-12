/**
 * Relay giriş noktası (konteyner içinde çalışır). Gizli bilgiler ortam değişkeninden DEĞİL,
 * dosyadan okunur (Docker secrets: /run/secrets/...). FAZ1-PLAN §9.3.
 *
 * Gerekli dosyalar:
 *   SAKLAZ_JWT_PRIVATE_KEY_FILE  — Ed25519 özel anahtar (PKCS#8 PEM)
 *   SAKLAZ_JWT_PUBLIC_KEY_FILE   — Ed25519 açık anahtar (SPKI PEM)
 *   SAKLAZ_MFA_KEY_FILE          — 32 bayt, hex (MFA sırlarının şifreleme anahtarı)
 *   SAKLAZ_DATABASE_URL_FILE     — PostgreSQL bağlantı adresi
 */
import { readFileSync } from "node:fs";
import { importPKCS8, importSPKI } from "jose";
import { initCrypto } from "@saklaz/crypto";
import { Accounts } from "./accounts.js";
import { createPool, migrate } from "./db.js";
import type { PushNotifier } from "./hub.js";
import { buildRelay } from "./server.js";

function secret(name: string): string {
  const path = process.env[name];
  if (!path) throw new Error(`${name} tanımlı değil`);
  return readFileSync(path, "utf8").trim();
}

/** FCM entegrasyonu Sprint 4'te. Şimdilik yalnızca sayaç tutar; hiçbir içerik göndermez. */
class NoopPush implements PushNotifier {
  wake(): Promise<void> {
    return Promise.resolve();
  }
}

async function main(): Promise<void> {
  await initCrypto();
  const pool = createPool(secret("SAKLAZ_DATABASE_URL_FILE"));
  await migrate(pool);
  const mfaKey = Buffer.from(secret("SAKLAZ_MFA_KEY_FILE"), "hex");
  if (mfaKey.length !== 32) throw new Error("MFA anahtarı 32 bayt olmalı");
  const accounts = new Accounts(pool, {
    jwtPrivateKey: await importPKCS8(secret("SAKLAZ_JWT_PRIVATE_KEY_FILE"), "EdDSA"),
    jwtPublicKey: await importSPKI(secret("SAKLAZ_JWT_PUBLIC_KEY_FILE"), "EdDSA"),
    mfaKey,
    issuer: process.env["SAKLAZ_RELAY_ID"] ?? "saklaz-relay",
  });
  const { app, hub } = buildRelay({ pool, accounts, relayId: process.env["SAKLAZ_RELAY_ID"] ?? "saklaz-relay", push: new NoopPush() });
  const sweep = setInterval(() => {
    void hub.sweepExpired();
  }, 60_000);
  const shutdown = () => {
    clearInterval(sweep);
    void app.close().then(() => pool.end());
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // Yalnızca konteyner ağında dinler; dışarıya ters vekil (Caddy) açılır.
  await app.listen({ host: process.env["SAKLAZ_LISTEN_HOST"] ?? "0.0.0.0", port: Number(process.env["SAKLAZ_PORT"] ?? "8080") });
}

void main();
