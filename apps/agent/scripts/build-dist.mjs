// Ajanı tek dosyalık ESM pakete derler (MVP alfa). Yerel modüller (SQLCipher) dışarıda bırakılır ve
// Windows paketleme adımında node_modules ile birlikte kopyalanır. DPAPI modülü, paket kökünde
// native/build/Release/keyprotect.node yolundan yüklenir (paketleme düzeni buna göredir).
import { build } from "esbuild";

await build({
  entryPoints: ["src/app/main.ts"],
  outfile: "dist/saklaz-agent.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  legalComments: "linked",
  external: ["better-sqlite3-multiple-ciphers", "bufferutil", "utf-8-validate"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
