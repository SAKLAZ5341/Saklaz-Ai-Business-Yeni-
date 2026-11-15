// keystore-probe.ts'yi tek dosyalık ESM pakete derler (yalnızca CI, T-A3-22b). Çıktı, DPAPI modülünü
// ../native/build/Release yolundan bulabilsin diye packages/win-keyprotect/dist/ altına yazılır.
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/keystore-probe.ts"],
  outfile: "../../packages/win-keyprotect/dist/keystore-probe.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["better-sqlite3-multiple-ciphers"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
