# ADR-0008: Kriptografi kütüphanesi ve Noise uygulaması

- **Durum:** Önerildi (Sprint 1). TypeScript tarafı uygulandı ve test edildi; Dart tarafı beklemede.
- **Tarih:** 2026-11-12

## Karar
1. **TypeScript (ajan, relay, masaüstü):** `libsodium-wrappers-sumo` 0.8.4 (WASM). Native derleme gerektirmez; Windows ve Linux'ta aynı ikili kod çalışır.
   - 0.7.16 sürümünün ESM paketlemesinde eksik dosya hatası vardı; 0.8.4'te giderilmiş olduğu doğrulandı.
2. **Noise:** Hazır bir npm paketi yerine, libsodium primitifleri üzerinde yalnızca KK desenini uygulayan küçük bir durum makinesi (`packages/crypto/src/noise.ts`, ~250 satır).
   - Gerekçe: Mevcut paketler native bağımlılık (sodium-native) getiriyor ve bakımı belirsiz. Küçük ve tek desenli bir uygulama denetlenebilir.
   - Güvence: **Resmî cacophony test vektörüyle birebir doğrulandı** (el sıkışma, el sıkışma özeti ve 4 taşıma mesajı).
3. **Özet fonksiyonu değişikliği:** Planda `Noise_KK_25519_ChaChaPoly_BLAKE2s` yazıyordu. libsodium BLAKE2s içermediği için **`Noise_KK_25519_ChaChaPoly_BLAKE2b`** seçildi. Güvenlik düzeyi eşdeğer veya daha yüksektir ve resmî vektörü mevcuttur.
4. **Dart (Android):** Karar Sprint 2 başında, Dart SDK erişimi olan bir ortamda verilecek.
   - Adaylar: `cryptography` (saf Dart), `sodium_libs` (libsodium FFI).
   - Ölçüt: `packages/protocol/test-vectors/saklaz-v1.json` ve Noise vektörünün birebir geçmesi.

## Sonuçlar
- Kendi kripto primitifimiz yoktur. Yalnızca Noise durum makinesi bizimdir ve vektörlerle sınanır.
- Faz 4 öncesi harici kripto incelemesinin kapsamı: `noise.ts`, `sealed.ts`, `pairing.ts`, `approval.ts`.
