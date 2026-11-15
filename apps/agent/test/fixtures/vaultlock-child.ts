/**
 * vaultlock-process.test.ts için alt süreç (esbuild ile paketlenir; gerçek src/app/filevault.ts).
 *   hold <kilit>                       kilidi al, "HELD <içerik>" yaz, öldürülene kadar bekle
 *   race <kilit> <başlangıç-ms> <tut-ms>  başlangıç anına kadar döngüde bekle, kilidi almayı dene;
 *                                       sonucu JSON yaz; aldıysa tut-ms boyunca tut ve bırak
 */
import { readFileSync } from "node:fs";
import { VaultError, VaultLock } from "../../src/app/filevault.js";

const [mode, lockPath, startAt, holdMs] = process.argv.slice(2);
if (!lockPath) process.exit(2);

if (mode === "hold") {
  VaultLock.acquire(lockPath);
  process.stdout.write(`HELD ${readFileSync(lockPath, "utf8")}\n`);
  setInterval(() => undefined, 60_000);
} else if (mode === "race") {
  const t0 = Number(startAt);
  while (Date.now() < t0) {
    /* aynı anda başlamak için döngüde bekle */
  }
  let lock: VaultLock | undefined;
  let code: string | null = null;
  try {
    lock = VaultLock.acquire(lockPath);
  } catch (e) {
    code = e instanceof VaultError ? e.code : String(e);
  }
  const content = lock ? readFileSync(lockPath, "utf8") : null;
  process.stdout.write(`${JSON.stringify({ pid: process.pid, ok: !!lock, code, content })}\n`);
  if (lock) {
    const l = lock;
    setTimeout(() => {
      // Kilit dosyası, alındığı andaki içerikle aynı mı (kaybeden silmedi / değiştirmedi)?
      let stillMine = false;
      try {
        stillMine = readFileSync(lockPath, "utf8") === content;
      } catch {
        stillMine = false;
      }
      l.release();
      process.stdout.write(`${JSON.stringify({ pid: process.pid, released: true, stillMine })}\n`);
    }, Number(holdMs));
  }
} else {
  process.exit(2);
}
