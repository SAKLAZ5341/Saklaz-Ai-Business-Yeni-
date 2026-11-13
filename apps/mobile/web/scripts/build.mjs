// Arayüzü tek bir HTML dosyasına derler (JS ve CSS gömülü). Çıktı: dist/index.html
// Flutter kabuğu bu dosyayı varlık (asset) olarak yükler; dış kaynak (CDN, yazı tipi) KULLANILMAZ.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const r = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: ["chrome100"],
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = readFileSync("src/style.css", "utf8");
const html = readFileSync("src/index.html", "utf8").replace("/*CSS*/", css).replace("/*JS*/", () => js);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", html);
console.log(`dist/index.html ${(html.length / 1024).toFixed(0)} KB`);
