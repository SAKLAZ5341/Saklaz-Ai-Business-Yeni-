// Relay üretim derlemesi (Sprint 3 A2).
//
// Kaynak kod ".js" uzantılı TypeScript içe aktarmaları kullanır; Node'un tip ayıklaması bunları
// çözemez (Sprint 2'deki bilinen Dockerfile eksiği). Bu betik relay'i ve çalışma alanı paketlerini
// (@saklaz/crypto, @saklaz/protocol) tek bir ESM dosyasına paketler. Üçüncü taraf paketler
// DIŞARIDA bırakılır ve imajda kilit dosyasındaki sürümleriyle kurulur (yerel modül @node-rs/argon2
// ve libsodium WASM dahil). Kaynak haritası üretilmez; imaja kaynak kod girmez.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const relayDir = join(here, "..");
const root = join(relayDir, "..", "..");

const depsOf = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies ?? {};
const relayDeps = depsOf(relayDir);
const external = [];
for (const dir of [relayDir, join(root, "packages", "crypto"), join(root, "packages", "protocol")]) {
  for (const [name, version] of Object.entries(depsOf(dir))) {
    if (name.startsWith("@saklaz/")) continue;
    // Paketlenmiş çalışma alanı kodunun ihtiyaç duyduğu her paket, imaja kurulabilmesi için relay'in
    // KENDİ bağımlılığı olmalı ve sürümü birebir aynı olmalı (ör. libsodium-wrappers-sumo).
    if (relayDeps[name] !== version) {
      console.error(`Sürüm uyuşmazlığı veya eksik bağımlılık: ${name} (${dir}: ${version}, relay: ${relayDeps[name] ?? "yok"})`);
      process.exit(1);
    }
    external.push(name);
  }
}

const result = await build({
  entryPoints: [join(relayDir, "src", "main.ts")],
  outfile: join(relayDir, "dist", "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: [...new Set(external)],
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
});

const inputs = Object.keys(result.metafile.inputs);
const bundled = inputs.filter((p) => p.includes("node_modules"));
if (bundled.length > 0) {
  console.error("Beklenmeyen üçüncü taraf kod pakete girdi:", bundled);
  process.exit(1);
}
console.log(`dist/main.mjs: ${inputs.length} kaynak dosya; dış bağımlılıklar: ${[...new Set(external)].sort().join(", ")}`);
