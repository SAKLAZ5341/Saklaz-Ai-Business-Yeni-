/**
 * Gerçek ProtectedKeyStore (kek.bin) izolasyon sınaması için yardımcı (Sprint 3 A3, T-A3-22b).
 * YALNIZCA CI'da, Windows'ta: tools/ci/dpapi-second-user.ps1 tarafından paketlenip çalıştırılır.
 * Anahtarı hiçbir zaman yazmaz; yalnızca SHA-256 özetini ve hata kodlarını yazar.
 *
 *   create <kek.bin>                    A: yeni kasa anahtarı dosyası; özet <kek.bin>.sha256
 *   verify <kek.bin>                    aynı kullanıcı: yükler ve özeti karşılaştırır
 *   cross  <A'nın kek.bin> <sonuç> <B'nin kek.bin>
 *                                       B: A'nın dosyasını yüklemeyi dener; kendi dosyasını oluşturup yükler
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { initCrypto } from "@saklaz/crypto";
// Doğrudan modüller: index.ts veritabanı (SQLCipher) modülünü de yükler; bu sınama ona ihtiyaç duymaz.
import { ProtectedKeyStore } from "../src/keystore.js";
import { DpapiUserProtector } from "../src/protectors/dpapi.js";
import { KeyProtectionError } from "../src/protectors/types.js";

await initCrypto();
const [mode, path, out, ownPath] = process.argv.slice(2);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const p = new DpapiUserProtector();

function digestAndWipe(k: Uint8Array): string {
  try {
    return sha(k);
  } finally {
    k.fill(0);
  }
}

if (mode === "create" && path) {
  const created = digestAndWipe(ProtectedKeyStore.create(path, p));
  writeFileSync(`${path}.sha256`, created);
  const ok = digestAndWipe(ProtectedKeyStore.load(path, p)) === created;
  console.log(JSON.stringify({ mode, sid: p.binding().userSid, ok }));
  if (!ok) process.exit(1);
} else if (mode === "verify" && path) {
  const ok = digestAndWipe(ProtectedKeyStore.load(path, p)) === readFileSync(`${path}.sha256`, "utf8");
  console.log(JSON.stringify({ mode, sid: p.binding().userSid, ok }));
  if (!ok) process.exit(1);
} else if (mode === "cross" && path && out && ownPath) {
  const result: Record<string, unknown> = { mode, sid: p.binding().userSid, crossOk: false, crossCode: null, selfOk: false };
  try {
    digestAndWipe(ProtectedKeyStore.load(path, p));
    result["crossOk"] = true; // OLMAMALI: başka kullanıcının kasa anahtarı açıldı
  } catch (e) {
    result["crossCode"] = e instanceof KeyProtectionError ? e.code : "UNKNOWN";
  }
  try {
    const mine = digestAndWipe(ProtectedKeyStore.create(ownPath, p));
    result["selfOk"] = digestAndWipe(ProtectedKeyStore.load(ownPath, p)) === mine;
  } catch (e) {
    result["selfCode"] = e instanceof KeyProtectionError ? e.code : "UNKNOWN";
  }
  writeFileSync(out, JSON.stringify(result));
} else {
  console.error("kullanım: keystore-probe create|verify|cross …");
  process.exit(2);
}
