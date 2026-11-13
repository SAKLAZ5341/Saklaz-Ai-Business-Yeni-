/**
 * Relay süreç giriş noktası (konteyner içinde çalışır). Sprint 3 A2.
 *
 *   node dist/main.mjs            relay'i başlatır (serve)
 *   node dist/main.mjs migrate    yalnızca şemayı uygular ve çıkar (kontrollü yükseltme)
 *
 * Bu dosya yalnızca süreç düzeyindeki işleri yapar: komut seçimi, sinyaller ve çıkış kodları.
 * Açılış mantığı run.ts'tedir. Çıkış kodları: 0 başarılı, 1 açılış veya çalışma hatası,
 * 2 bilinmeyen komut.
 */
import { createLogger, describeError, runMigrate, runServer } from "./run.js";

const log = createLogger();

// Yakalanmamış bir hata, sürecin bilinmeyen bir durumda çalışmaya devam etmesi yerine çıkışla
// sonuçlanır; konteyner yeniden başlatma politikası süreci temiz durumdan yeniden başlatır.
process.on("unhandledRejection", (e) => {
  log("fatal", "yakalanmamış hata", describeError(e));
  process.exit(1);
});
process.on("uncaughtException", (e) => {
  log("fatal", "yakalanmamış istisna", describeError(e));
  process.exit(1);
});

function fail(e: unknown): never {
  log("fatal", "açılış başarısız", describeError(e));
  process.exit(1);
}

const cmd = process.argv[2] ?? "serve";
if (cmd === "migrate") {
  runMigrate(process.env, log).then(() => process.exit(0), fail);
} else if (cmd === "serve") {
  runServer(process.env, log).then((relay) => {
    let stopping = false;
    const shutdown = (signal: string) => {
      if (stopping) return;
      stopping = true;
      log("info", "kapanıyor", { signal });
      setTimeout(() => {
        log("error", "düzgün kapanma zaman aşımına uğradı");
        process.exit(1);
      }, 10_000).unref();
      relay.stop().then(
        () => {
          log("info", "kapandı");
          process.exit(0);
        },
        (e: unknown) => {
          log("error", "kapanırken hata", describeError(e));
          process.exit(1);
        },
      );
    };
    process.on("SIGTERM", () => {
      shutdown("SIGTERM");
    });
    process.on("SIGINT", () => {
      shutdown("SIGINT");
    });
  }, fail);
} else {
  log("fatal", "bilinmeyen komut", { command: cmd });
  process.exit(2);
}
