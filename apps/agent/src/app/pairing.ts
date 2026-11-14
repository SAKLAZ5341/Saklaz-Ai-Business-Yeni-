/**
 * Komut satırı eşleştirme akışı (MVP alfa). Komut satırından ayrıldı ki her çıkış yolu sınanabilsin:
 *   • Arka plan görevi eşleştirme sırasında durdurulur ve servis AÇILAMASA bile yeniden başlatılır.
 *   • QR dosyası (pairing-qr.svg) başarı, ret, hata ve zaman aşımında her durumda silinir.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BackgroundTask {
  /** Görev çalışıyorduysa durdurur ve true döner. */
  stop(): boolean;
  start(): void;
}

/** fn sırasında arka plan görevi durur; fn (veya servis açılışı) hata verse bile görev yeniden başlatılır. */
export async function withBackgroundTaskPaused<T>(task: BackgroundTask, fn: () => Promise<T>): Promise<T> {
  const wasRunning = task.stop();
  try {
    return await fn();
  } finally {
    if (wasRunning) task.start();
  }
}

export interface PairingService {
  readonly dir: string;
  readonly config: unknown;
  readonly isLoggedIn: boolean;
  connect(): { waitReady(ms: number): Promise<void> };
  startPairing(): string;
  waitForSas(timeoutMs?: number): Promise<string>;
  confirmPairing(matches: boolean): boolean;
  waitLinked(timeoutMs?: number): Promise<void>;
}

export interface PairingIo {
  print(text: string): void;
  error(text: string): void;
  ask(question: string): Promise<string>;
  terminalQr(code: string): Promise<string>;
  svgQr(code: string): Promise<string>;
}

export const PAIRING_QR_FILE = "pairing-qr.svg";

export async function runPairing(svc: PairingService, io: PairingIo, profile: string): Promise<number> {
  if (!svc.config || !svc.isLoggedIn) {
    io.error(`Önce kurulum yapın: saklaz-agent setup --profile ${profile}`);
    return 1;
  }
  const client = svc.connect();
  await client.waitReady(20_000);
  const code = svc.startPairing();
  const svgPath = join(svc.dir, PAIRING_QR_FILE);
  try {
    io.print("\nTelefonda SAKLAZ → Cihazlar → Bilgisayar ekle → QR kodu okutun:\n");
    io.print(await io.terminalQr(code));
    writeFileSync(svgPath, await io.svgQr(code), { mode: 0o600 });
    io.print(`QR terminalde okunmuyorsa: ${svgPath}`);
    io.print(`veya telefona elle girin:\n${code}\n`);
    io.print("Kod 5 dakika geçerlidir. Telefon bekleniyor…");
    const sas = await svc.waitForSas();
    io.print(`\nGÜVENLİK KODU (SAS):  ${sas}\n`);
    const ok = (await io.ask("Telefonda görünen kod bununla AYNI mı? (e/h): ")).toLowerCase().startsWith("e");
    if (!svc.confirmPairing(ok)) {
      io.error("Eşleştirme iptal edildi.");
      return 1;
    }
    await svc.waitLinked(120_000);
    io.print("Eşleştirme tamamlandı. Telefon bu bilgisayarın sahibi olarak bağlandı.");
    return 0;
  } finally {
    rmSync(svgPath, { force: true });
  }
}
