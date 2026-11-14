/** Ajan süreç giriş noktası (paketlenmiş dağıtım: dist/saklaz-agent.mjs). */
import { main } from "./cli.js";

process.on("unhandledRejection", () => {
  console.error("Beklenmeyen hata (ayrıntı günlükte değil).");
  process.exit(1);
});
process.exitCode = await main(process.argv.slice(2));
