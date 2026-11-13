/**
 * İzin verilen komutlar (MVP alfa). YALNIZCA salt okunur bilgi komutları vardır; kabuk komutu,
 * dosya yazma, program başlatma YOKTUR. Listede olmayan her metin NOT_ALLOWED ile reddedilir.
 * Yetki: komut, çekirdekte cihaz listesine göre imza, rol (link.set), tekrar oynatma ve zaman
 * denetiminden geçtikten SONRA buraya gelir.
 */
import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import os from "node:os";

export interface CommandResult {
  ok: boolean;
  summary: string;
  code?: string;
  /** Günlüğe yazılabilecek komut adı (komut metni değil). */
  name: string;
}

interface Spec {
  name: string;
  aliases: string[];
  help: string;
  run: () => Promise<string> | string;
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
const dur = (sec: number) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d ? `${String(d)} gün ` : ""}${String(h)} sa ${String(m)} dk`;
};

function sysinfo(): string {
  const cpus = os.cpus();
  return [
    `Bilgisayar: ${os.hostname()}`,
    `İşletim sistemi: ${os.version()} (${os.release()}, ${os.arch()})`,
    `İşlemci: ${cpus[0]?.model.trim() ?? "?"} × ${String(cpus.length)}`,
    `Bellek: ${gb(os.totalmem() - os.freemem())} / ${gb(os.totalmem())} kullanımda`,
    `Çalışma süresi: ${dur(os.uptime())}`,
    `Kullanıcı: ${os.userInfo().username}`,
  ].join("\n");
}

function disk(): string {
  const roots = process.platform === "win32" ? ["C:\\", "D:\\", "E:\\"] : ["/"];
  const lines: string[] = [];
  for (const r of roots) {
    try {
      const s = statfsSync(r);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      lines.push(`${r}  boş ${gb(free)} / toplam ${gb(total)} (%${String(Math.round((100 * (total - free)) / total))} dolu)`);
    } catch {
      /* sürücü yok */
    }
  }
  return lines.join("\n") || "Disk bilgisi alınamadı.";
}

function network(): string {
  const lines: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) lines.push(`${name}: ${a.address}`);
  }
  return lines.join("\n") || "Etkin ağ bağdaştırıcısı yok.";
}

function processes(): Promise<string> {
  if (process.platform !== "win32") return Promise.resolve("İşlem listesi yalnızca Windows'ta desteklenir.");
  return new Promise((resolve) => {
    // Sabit argümanlar; kabuk kullanılmaz.
    execFile("tasklist.exe", ["/fo", "csv", "/nh"], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) {
        resolve("İşlem listesi alınamadı.");
        return;
      }
      const rows = out
        .split(/\r?\n/)
        .map((l) => l.split('","').map((x) => x.replace(/^"|"$/g, "")))
        .filter((c) => c.length >= 5)
        .map((c) => ({ name: c[0] ?? "?", kb: Number((c[4] ?? "0").replace(/[^\d]/g, "")) }));
      rows.sort((a, b) => b.kb - a.kb);
      resolve(
        "En çok bellek kullanan 15 işlem:\n" + rows.slice(0, 15).map((r) => `${r.name} — ${(r.kb / 1024).toFixed(0)} MB`).join("\n"),
      );
    });
  });
}

const SPECS: Spec[] = [
  { name: "sistem", aliases: ["sistem bilgisi", "sysinfo", "bilgi"], help: "Bilgisayar, işletim sistemi, işlemci, bellek", run: sysinfo },
  { name: "disk", aliases: ["diskler", "depolama"], help: "Disk doluluk durumu", run: disk },
  { name: "ağ", aliases: ["ag", "network", "ip"], help: "Ağ bağdaştırıcıları ve IPv4 adresleri", run: network },
  { name: "işlemler", aliases: ["islemler", "processes", "görevler"], help: "En çok bellek kullanan işlemler", run: processes },
  { name: "çalışma süresi", aliases: ["uptime", "calisma suresi"], help: "Açık kalma süresi", run: () => `Çalışma süresi: ${dur(os.uptime())}` },
  { name: "ping", aliases: [], help: "Bağlantı denemesi", run: () => `pong — ${os.hostname()} ${new Date().toISOString()}` },
];

export function helpText(): string {
  return "İzin verilen komutlar:\n" + SPECS.map((s) => `• ${s.name} — ${s.help}`).join("\n") + "\n• yardım — bu liste";
}

export function allowedCommandNames(): string[] {
  return [...SPECS.map((s) => s.name), "yardım"];
}

export async function runCommand(text: string): Promise<CommandResult> {
  const t = text.trim().toLocaleLowerCase("tr-TR");
  if (t === "yardım" || t === "yardim" || t === "help") return { ok: true, summary: helpText(), name: "yardım" };
  const spec = SPECS.find((s) => s.name === t || s.aliases.includes(t));
  if (!spec) return { ok: false, code: "NOT_ALLOWED", summary: `Bu komut izinli değil.\n${helpText()}`, name: "?" };
  try {
    const out = await spec.run();
    return { ok: true, summary: out.slice(0, 3900), name: spec.name };
  } catch {
    return { ok: false, code: "COMMAND_FAILED", summary: "Komut çalıştırılamadı.", name: spec.name };
  }
}
