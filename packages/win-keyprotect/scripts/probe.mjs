// DPAPI izolasyon sınaması için yardımcı (Sprint 3 A3). Yalnızca CI'da ve Windows'ta kullanılır:
// tools/ci/dpapi-second-user.ps1. Hiçbir zaman düz metni dosyaya veya çıktıya YAZMAZ; yalnızca
// özetini ve sonuç kodlarını yazar.
//
//   node probe.mjs protect <blob>            rastgele 32 bayt korur; blob ve düz metnin SHA-256'sı
//   node probe.mjs verify  <blob>            aynı kullanıcı: çözer ve özeti karşılaştırır
//   node probe.mjs cross   <blob> <sonuç>    BAŞKA kullanıcı: çözmeyi dener; kendi verisiyle gidiş-dönüş
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const native = createRequire(import.meta.url)("../native/build/Release/keyprotect.node");
const ENTROPY = Buffer.from("SAKLAZ-v1/ci-dpapi-probe", "utf8");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const [mode, blobPath, outPath] = process.argv.slice(2);

if (mode === "protect") {
  const secret = randomBytes(32);
  const blob = native.protect(secret, ENTROPY);
  writeFileSync(blobPath, blob);
  writeFileSync(`${blobPath}.sha256`, sha(secret));
  const back = native.unprotect(blob, ENTROPY);
  if (sha(back) !== sha(secret)) throw new Error("gidiş-dönüş başarısız");
  secret.fill(0);
  console.log(JSON.stringify({ mode, sid: native.userSid(), ok: true }));
} else if (mode === "verify") {
  const back = native.unprotect(readFileSync(blobPath), ENTROPY);
  const ok = sha(back) === readFileSync(`${blobPath}.sha256`, "utf8");
  console.log(JSON.stringify({ mode, sid: native.userSid(), ok }));
  if (!ok) process.exit(1);
} else if (mode === "cross") {
  const result = { mode, sid: native.userSid(), crossOk: false, crossCode: null, selfOk: false };
  try {
    const back = native.unprotect(readFileSync(blobPath), ENTROPY);
    result.crossOk = true; // OLMAMALI: başka kullanıcının verisi çözüldü
    result.crossMatches = sha(back) === readFileSync(`${blobPath}.sha256`, "utf8");
  } catch (e) {
    result.crossCode = typeof e?.code === "string" ? e.code : "UNKNOWN";
  }
  const own = randomBytes(32);
  result.selfOk = sha(native.unprotect(native.protect(own, ENTROPY), ENTROPY)) === sha(own);
  writeFileSync(outPath, JSON.stringify(result));
} else {
  console.error("kullanım: probe.mjs protect|verify|cross <blob> [sonuç]");
  process.exit(2);
}
