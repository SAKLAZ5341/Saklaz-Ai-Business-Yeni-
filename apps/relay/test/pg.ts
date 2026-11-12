/**
 * Test için geçici PostgreSQL.
 *   • SAKLAZ_TEST_PG_URL varsa (CI'daki postgres servisi): her test dosyası için ayrı veritabanı oluşturulur.
 *   • Yoksa: yerel PostgreSQL ikilileriyle geçici bir küme başlatılır. Küme yalnızca Unix soketinden
 *     dinler, TCP portu açılmaz; root ile çalışılıyorsa "nobody" kullanıcısı kullanılır.
 * İkisi de yoksa testler atlanır ve bu durum açıkça raporlanır.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import pg from "pg";

export interface TestPg {
  url: string;
  stop: () => Promise<void>;
}

function findBin(): string | undefined {
  const root = "/usr/lib/postgresql";
  if (!existsSync(root)) return undefined;
  const versions = readdirSync(root).sort().reverse();
  for (const v of versions) {
    const b = join(root, v, "bin");
    if (existsSync(join(b, "initdb"))) return b;
  }
  return undefined;
}

export function pgAvailable(): boolean {
  return !!process.env["SAKLAZ_TEST_PG_URL"] || !!findBin();
}

export async function startPg(): Promise<TestPg> {
  const external = process.env["SAKLAZ_TEST_PG_URL"];
  if (external) {
    const name = `saklaz_t_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Client({ connectionString: external });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const u = new URL(external);
    u.pathname = `/${name}`;
    return {
      url: u.toString(),
      stop: async () => {
        const a = new pg.Client({ connectionString: external });
        await a.connect();
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await a.end();
      },
    };
  }
  const bin = findBin();
  if (!bin) throw new Error("PostgreSQL bulunamadı");
  const dir = mkdtempSync("/var/tmp/saklaz-pg-");
  chmodSync(dir, 0o777);
  const asRoot = process.getuid?.() === 0;
  const run = (cmd: string) => {
    if (asRoot) execFileSync("su", ["nobody", "-s", "/bin/sh", "-c", cmd], { stdio: "pipe" });
    else execFileSync("/bin/sh", ["-c", cmd], { stdio: "pipe" });
  };
  run(`${bin}/initdb -D ${dir}/data -U postgres -A trust >/dev/null`);
  run(`${bin}/pg_ctl -D ${dir}/data -o "-k ${dir} -c listen_addresses=''" -l ${dir}/log -w start >/dev/null`);
  return {
    url: `postgresql://postgres@/postgres?host=${encodeURIComponent(dir)}`,
    stop: () => {
      try {
        run(`${bin}/pg_ctl -D ${dir}/data -m fast -w stop >/dev/null`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return Promise.resolve();
    },
  };
}
