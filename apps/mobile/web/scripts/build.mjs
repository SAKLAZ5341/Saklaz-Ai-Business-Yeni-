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
let html = readFileSync("src/index.html", "utf8").replace("/*CSS*/", css).replace("/*JS*/", () => js);
// Üretim (Android kabuğu): connect-src 'none' — WebView hiçbir ağ bağlantısı açamaz; HTTP ve WebSocket
// yalnızca kabuk köprüsünden (hedef politikası + onay). Masaüstü tarayıcıda GÜVENSİZ geliştirme kipi için
// SAKLAZ_WEB_DEV_INSECURE=1 ile ayrı bir dosya üretilir; bu dosya uygulama paketine KONULMAZ.
if (!html.includes("connect-src 'none'")) throw new Error("CSP: connect-src 'none' bulunamadı");
const dev = process.env.SAKLAZ_WEB_DEV_INSECURE === "1";
const out = dev ? "dist/index.dev-insecure.html" : "dist/index.html";
if (dev) html = html.replace("connect-src 'none'", "connect-src http: https: ws: wss:");
mkdirSync("dist", { recursive: true });
writeFileSync(out, html);
console.log(`${out} ${(html.length / 1024).toFixed(0)} KB`);
