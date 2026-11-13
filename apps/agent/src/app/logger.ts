/**
 * Ajan günlüğü: JSON satırları, boyut sınırlı (5 MB, 1 yedek). Yalnızca olay adı ve kodlar yazılır;
 * anahtar, token, parola, komut metni veya komut çıktısı YAZILMAZ.
 * Boyut, açık dosya tanıtıcısından (fstat) okunur; yol üzerinden "denetle-sonra-kullan" yapılmaz.
 */
import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, event: string, meta?: Record<string, string | number | boolean | null>) => void;

const MAX = 5 * 1024 * 1024;

export function createFileLogger(dir: string, alsoConsole = true): Logger {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "agent.log");
  let fd: number | undefined;
  const open = () => {
    fd = openSync(file, "a", 0o600);
    return fd;
  };
  return (level, event, meta = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta });
    try {
      let f = fd ?? open();
      if (fstatSync(f).size > MAX) {
        closeSync(f);
        fd = undefined;
        renameSync(file, `${file}.1`);
        f = open();
      }
      writeSync(f, line + "\n");
    } catch {
      /* günlük yazılamazsa ajan durmaz */
    }
    if (alsoConsole) (level === "error" ? console.error : console.log)(line);
  };
}
