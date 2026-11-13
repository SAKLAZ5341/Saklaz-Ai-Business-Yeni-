/**
 * Ajan günlüğü: JSON satırları, boyut sınırlı (5 MB, 1 yedek). Yalnızca olay adı ve kodlar yazılır;
 * anahtar, token, parola, komut metni veya komut çıktısı YAZILMAZ.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, event: string, meta?: Record<string, string | number | boolean | null>) => void;

const MAX = 5 * 1024 * 1024;

export function createFileLogger(dir: string, alsoConsole = true): Logger {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "agent.log");
  return (level, event, meta = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta });
    try {
      if (existsSync(file) && statSync(file).size > MAX) renameSync(file, `${file}.1`);
      appendFileSync(file, line + "\n", { mode: 0o600 });
    } catch {
      /* günlük yazılamazsa ajan durmaz */
    }
    if (alsoConsole) (level === "error" ? console.error : console.log)(line);
  };
}
