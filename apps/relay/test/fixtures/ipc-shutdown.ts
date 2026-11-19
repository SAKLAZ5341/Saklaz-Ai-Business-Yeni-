/**
 * YALNIZCA TEST İÇİN ön yükleme modülü (`node --import`). Üretim imajına girmez; src/ dışındadır.
 *
 * Windows'ta POSIX sinyalleri süreçler arasında iletilemez: `child.kill("SIGTERM")` Windows'ta
 * TerminateProcess ile süreci koşulsuz sonlandırır, main.ts'teki SIGTERM işleyicisi hiç çalışmaz ve
 * çıkış kodu `null` olur. Bu modül, üst süreçten IPC kanalıyla gelen kapanma isteğini süreç içinde
 * `process.emit("SIGTERM")` olarak yayımlar. Böylece main.ts'te HİÇBİR değişiklik yapmadan, gerçek
 * sinyal işleyicisi, düzgün kapanma yolu ve 10 saniyelik zaman aşımı aynen sınanır; yalnızca sinyalin
 * teslim edilme biçimi farklıdır.
 *
 * IPC kanalı yoksa (normal çalıştırma) hiçbir şey yapmaz.
 */
export const IPC_SHUTDOWN_MESSAGE = "saklaz-test:shutdown";

if (typeof process.send === "function") {
  process.on("message", (m: unknown) => {
    if (m === IPC_SHUTDOWN_MESSAGE) process.emit("SIGTERM", "SIGTERM");
  });
}
