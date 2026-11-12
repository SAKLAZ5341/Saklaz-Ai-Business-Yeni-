// MVP bağımsızlık kuralı (FAZ1-PLAN §12, D5):
// - apps/* ve ERP dışı paketler, @saklaz/erp-* paketlerini içe aktaramaz.
// - Faz 2 kararı alınana kadar bu kural kaldırılmaz.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const forbidden = /from\s+["']@saklaz\/erp-|import\(\s*["']@saklaz\/erp-|require\(\s*["']@saklaz\/erp-/;
const scanDirs = ["apps", "packages"];
const violations = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (relative(root, p).startsWith("packages/erp-")) continue; // ERP paketleri kendi içinde serbest
      walk(p);
    } else if (/\.(c|m)?(t|j)sx?$/.test(name)) {
      const text = readFileSync(p, "utf8");
      if (forbidden.test(text)) violations.push(relative(root, p));
    } else if (name === "package.json") {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      for (const d of Object.keys(deps)) if (d.startsWith("@saklaz/erp-")) violations.push(`${relative(root, p)} -> ${d}`);
    }
  }
}

for (const d of scanDirs) {
  try { walk(join(root, d)); } catch (e) { if (e.code !== "ENOENT") throw e; }
}

if (violations.length) {
  console.error("ERP bağımlılık kuralı ihlali (MVP, ASEDEN'den bağımsız olmalı):");
  for (const v of violations) console.error("  - " + v);
  process.exit(1);
}
console.log("Sınır kontrolü: OK (ERP bağımlılığı yok)");
