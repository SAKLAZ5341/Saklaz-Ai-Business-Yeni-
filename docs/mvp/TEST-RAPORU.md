# SAKLAZ AI 0.1.0-alpha — Test raporu

Tarih: 2026-11-13. Dal: `feat/mvp-alpha` (PR #13). Testler iki yerde koştu:
- **Yerel:** Linux, Node 22, PostgreSQL 16, Chromium (Playwright 1.63).
- **GitHub CI:** ubuntu-24.04 ve windows-2022.

## Özet

| Alan | Sonuç |
|---|---|
| Birim ve entegrasyon testleri (Linux) | **Geçti**: 248 geçti, 15 atlandı (14 Windows'a özgü, 1 Playwright gerektiren) |
| Windows CI: kripto, protokol, ajan, DPAPI | **Geçti** (ikinci Windows kullanıcısı izolasyonu dahil) |
| Windows paketi: gerçek DPAPI ile öz-sınama + başlangıç görevi kur/kaldır | **Geçti** |
| Android APK derlemesi + `flutter analyze` | **Geçti** (APK derlendi; **cihazda çalıştırılmadı**) |
| Lint, tip, sınır kontrolü, gitleaks, CodeQL | **Geçti** |
| Docker relay imajı + Compose entegrasyonu | **Geçti** |
| Gerçek cihaz testleri | **Bekliyor** ([BILINEN-EKSIKLER.md](BILINEN-EKSIKLER.md)) |

## Uçtan uca testler (gerçek relay HTTP/WebSocket + PostgreSQL)

### `apps/relay/test/mvp-e2e.test.ts`
Ajan servisi + üretim telefon istemcisi; test simülatörü kullanılmadı. **Geçti** (yerel ve CI).
- Hesap oluşturma, parola + TOTP giriş (TOTP tekrar kullanım koruması altında), cihaz kaydı (anahtar kanıtı; ikinci kayıt "exists")
- QR + SAS ile iki bilgisayarın eşleştirilmesi. İkinci bilgisayar listeyi aldı, birinci bilgisayar yeni girişleri aldı.
- `sistem` ve `ping` sonuçları doğru bilgisayardan, imzalı olarak geldi
- `del /s /q C:\` → `NOT_ALLOWED`
- Tekrar oynatılan çerçeveler yeni mesaj üretmedi
- Telefon durumu güvenli depodan geri yüklendi; ajan yeniden açıldı (aynı kimlik, kasa çözüldü); ikisinden sonra da komut çalıştı
- Relay veritabanında komut sonucu ve hata kodu düz metin olarak yok

### `apps/relay/test/mobile-ui.e2e.test.ts`
Derlenmiş Android arayüzü Chromium'da. **Geçti, yalnızca yerelde** (CI'da Playwright yok, atlanır).
- Arayüzden hesap oluşturma → TOTP ile giriş → relay bağlantısı (yeşil)
- Arayüzden eşleştirme: SAS, ajanınkiyle aynı
- Komut düğmesi → sonuç kartı; `format c:` → "izinli değil"
- Yerel AI (OpenAI uyumlu sahte sunucu) → yanıt
- OpenAI anahtarı yokken → açık hata, istek gönderilmedi
- Görev ekleme
- Sayfa yeniden yüklendi (uygulama yeniden açıldı) → bilgisayar listesi ve komut çalışıyor
- Kabuk deposunda parola yok; sayfa hatası yok

## Paket bazında (yerel `pnpm run ci`)

| Paket | Test | Kapsam (satır) |
|---|---|---|
| crypto | 34 | eşik ≥ %95 (değişmedi) |
| protocol | 88 | değişmedi |
| win-keyprotect | 5 + 7 Windows'ta | — |
| client-core (yeni) | 8 | %86.6 |
| agent | 49 + 7 Windows'ta | %92.9 |
| mobile-web (yeni) | 6 | — |
| relay | 58 + 1 Playwright gerektiren | — |

## Bulunan ve düzeltilen hatalar

| Hata | Bulunduğu yer | Düzeltme |
|---|---|---|
| İkinci bilgisayar eklenince birinci bilgisayar listede geride kalıyor ve komutları `ROSTER_BEHIND` ile reddediyordu | Uçtan uca test | Telefon yeni girişleri diğer bilgisayarlara yayar ve `roster.need` isteğine yanıt verir |
| Komut sonucu, ack'ten önce şifrelendiği için Noise sırası bozuluyor, oturum sıfırlanıyor ve sonuç kayboluyordu | Uçtan uca test | Komut ack gönderildikten sonra çalışır |
| Günlük dosyasında denetle-sonra-kullan yarışı | CodeQL | Boyut, açık tanıtıcıdan (fstat) okunur |
| Testteki sahte token değeri sır olarak algılandı | gitleaks | Değer açıkça yer tutucu yapıldı; geçmiş commit için `.gitleaksignore` girdisi eklendi |
| androidx.webkit 1.14, Android Gradle eklentisi ≥ 8.1.1 istiyordu | APK derlemesi | AGP 8.7.0 + Gradle 8.10.2 |
