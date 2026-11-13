/**
 * SAKLAZ ajanı komut satırı (MVP alfa).
 *
 *   saklaz-agent setup  [--profile personal|business]   relay adresi, bilgisayar adı, hesap girişi
 *   saklaz-agent pair   [--profile …]                   QR + SAS ile telefon eşleştirme
 *   saklaz-agent run    [--profile …]                   arka plan servisi (başlangıç görevi bunu çalıştırır)
 *   saklaz-agent status [--profile …]
 *   saklaz-agent lockdown [--profile …]                  yerel acil kilit
 *   saklaz-agent selftest                               ağ olmadan: anahtar koruma, kasa, veritabanı
 *
 * Parola ve TOTP kodu yalnızca bellekte tutulur; diske ve günlüğe yazılmaz.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { initCrypto } from "@saklaz/crypto";
import QRCode from "qrcode";
import { allowedCommandNames } from "./commands.js";
import { createFileLogger, type Logger } from "./logger.js";
import { AgentService, isProfile, profileDir, type Profile } from "./service.js";

export const AGENT_VERSION = "0.1.0-alpha";

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function ask(q: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const w = (rl as unknown as { _writeToOutput: (s: string) => void });
      w._writeToOutput = (s: string) => {
        if (s.includes(q)) process.stdout.write(s);
        else if (s === "\r\n" || s === "\n") process.stdout.write("\n");
      };
    }
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

function taskName(profile: Profile): string {
  return `SAKLAZ Agent (${profile})`;
}

/** Eşleştirme sırasında arka plan görevi aynı kimlikle bağlı kalmasın diye durdurulur. */
function stopBackgroundTask(profile: Profile): boolean {
  if (process.platform !== "win32") return false;
  try {
    execFileSync("schtasks.exe", ["/end", "/tn", taskName(profile)], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function startBackgroundTask(profile: Profile): void {
  if (process.platform !== "win32") return;
  try {
    execFileSync("schtasks.exe", ["/run", "/tn", taskName(profile)], { stdio: "ignore", windowsHide: true });
  } catch {
    /* görev kurulu değil */
  }
}

async function openService(profile: Profile, log: Logger): Promise<AgentService> {
  await initCrypto();
  return new AgentService({ profile, log, allowInsecureRelay: process.env["SAKLAZ_ALLOW_INSECURE_RELAY"] === "1" });
}

async function setup(profile: Profile, log: Logger): Promise<number> {
  const svc = await openService(profile, log);
  try {
    console.log(`SAKLAZ ajanı kurulumu — profil: ${profile}`);
    const relay = (await ask(`Relay adresi (ör. wss://relay.ornek.com)${svc.config ? ` [${svc.config.relayUrl}]` : ""}: `)) || svc.config?.relayUrl || "";
    const label = (await ask(`Bu bilgisayarın adı${svc.config ? ` [${svc.config.label}]` : " (ör. Ev bilgisayarı)"}: `)) || svc.config?.label || "Bilgisayar";
    svc.configure(relay, label);
    const email = await ask("Hesap e-postası: ");
    const password = await ask("Parola: ", true);
    const code = await ask("Doğrulama uygulamasındaki 6 haneli kod: ");
    await svc.login(email, password, code);
    console.log("Giriş başarılı. Bu bilgisayar hesaba kaydedildi.");
    console.log(`Sonraki adım: saklaz-agent pair --profile ${profile}`);
    return 0;
  } finally {
    svc.close();
  }
}

async function pair(profile: Profile, log: Logger): Promise<number> {
  const wasRunning = stopBackgroundTask(profile);
  const svc = await openService(profile, log);
  try {
    if (!svc.config || !svc.isLoggedIn) {
      console.error(`Önce kurulum yapın: saklaz-agent setup --profile ${profile}`);
      return 1;
    }
    const client = svc.connect();
    await client.waitReady(20_000);
    const code = svc.startPairing();
    console.log("\nTelefonda SAKLAZ → Bilgisayarlar → Bilgisayar ekle → QR kodu okutun:\n");
    console.log(await QRCode.toString(code, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
    const svgPath = join(svc.dir, "pairing-qr.svg");
    writeFileSync(svgPath, await QRCode.toString(code, { type: "svg", margin: 2, width: 360 }), { mode: 0o600 });
    console.log(`QR terminalde okunmuyorsa: ${svgPath}`);
    console.log(`veya telefona elle girin:\n${code}\n`);
    console.log("Kod 5 dakika geçerlidir. Telefon bekleniyor…");
    const sas = await svc.waitForSas();
    console.log(`\nGÜVENLİK KODU (SAS):  ${sas}\n`);
    const ok = (await ask("Telefonda görünen kod bununla AYNI mı? (e/h): ")).toLowerCase().startsWith("e");
    rmSync(svgPath, { force: true });
    if (!svc.confirmPairing(ok)) {
      console.error("Eşleştirme iptal edildi.");
      return 1;
    }
    await svc.waitLinked(120_000);
    console.log("Eşleştirme tamamlandı. Telefon bu bilgisayarın sahibi olarak bağlandı.");
    return 0;
  } finally {
    svc.close();
    if (wasRunning) startBackgroundTask(profile);
  }
}

async function run(profile: Profile, log: Logger): Promise<number> {
  const svc = await openService(profile, log);
  if (!svc.config || !svc.isLoggedIn) {
    log("error", "run.not_configured");
    svc.close();
    return 1;
  }
  log("info", "run.start", { version: AGENT_VERSION, commands: allowedCommandNames().join(",") });
  svc.connect();
  await new Promise<void>((resolve) => {
    const stop = () => {
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  log("info", "run.stop");
  svc.close();
  return 0;
}

async function status(profile: Profile, log: Logger): Promise<number> {
  const svc = await openService(profile, log);
  try {
    const st = svc.core.rosterLog?.current;
    const phones = st ? [...st.devices.values()].filter((d) => d.kind === "phone" && !d.revoked).map((d) => d.label) : [];
    console.log(
      JSON.stringify(
        {
          version: AGENT_VERSION,
          profile,
          dir: svc.dir,
          deviceId: svc.core.deviceId,
          relay: svc.config?.relayUrl ?? null,
          label: svc.config?.label ?? null,
          loggedIn: svc.isLoggedIn,
          paired: !!svc.core.workspaceId,
          phones,
          locked: svc.core.lockdown.locked,
          vault: svc.core.db.open ? "ok" : "closed",
        },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    svc.close();
  }
}

/** Ağ gerektirmeyen duman testi (CI ve kurulum sonrası). Geçici klasör kullanır, sonra siler. */
async function selftest(log: Logger): Promise<number> {
  await initCrypto();
  const home = mkdtempSync(join(tmpdir(), "saklaz-selftest-"));
  try {
    const opts = { profile: "personal" as const, log, dir: join(home, "agent-personal") };
    const a = new AgentService(opts);
    const id = a.core.deviceId;
    a.configure("wss://relay.example.invalid", "Selftest");
    a.close();
    const b = new AgentService(opts); // yeniden açılış: aynı kimlik, kasa çözülebiliyor
    const same = b.core.deviceId === id;
    b.close();
    console.log(JSON.stringify({ selftest: same ? "OK" : "FAIL", vault: process.platform === "win32" ? "dpapi" : "insecure-file", deviceIdStable: same }));
    return same ? 0 : 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "help";
  const profileArg = arg("profile", argv) ?? "personal";
  if (!isProfile(profileArg)) {
    console.error("Profil personal veya business olmalı.");
    return 2;
  }
  const profile = profileArg;
  if (cmd === "selftest") return selftest(createFileLogger(join(tmpdir(), "saklaz-selftest-logs"), false));
  if (cmd === "version" || cmd === "--version") {
    console.log(AGENT_VERSION);
    return 0;
  }
  const log = createFileLogger(join(profileDir(profile), "logs"), cmd === "run");
  try {
    switch (cmd) {
      case "setup":
        return await setup(profile, log);
      case "pair":
        return await pair(profile, log);
      case "run":
        return await run(profile, log);
      case "status":
        return await status(profile, log);
      case "lockdown": {
        const svc = await openService(profile, log);
        svc.core.engageLocalLockdown("cli");
        svc.close();
        console.log("Acil kilit devrede. Bu profil hiçbir komutu kabul etmez.");
        return 0;
      }
      default:
        console.log("Kullanım: saklaz-agent setup|pair|run|status|lockdown|selftest|version [--profile personal|business]");
        return cmd === "help" ? 0 : 2;
    }
  } catch (e) {
    const code = e instanceof Error && /^[A-Z_]{2,64}$/.test(e.message) ? e.message : e instanceof Error && "code" in e ? String((e as { code: unknown }).code) : "ERROR";
    log("error", "cli.failed", { cmd, code });
    console.error(`Hata: ${code}`);
    return 1;
  }
}
