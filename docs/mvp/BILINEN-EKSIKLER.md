# SAKLAZ AI 0.1.0-alpha — Bilinen eksikler ve gerçek cihaz test listesi

## Doğrulanmamış (yalnızca gerçek cihazda doğrulanabilir)

| # | Konu | Neden doğrulanmadı |
|---|---|---|
| G1 | APK'nın gerçek Android telefonda kurulması ve açılması | CI APK'yı derler, çalıştırmaz. Emülatör/cihaz testi yapılmadı. |
| G2 | Flutter kabuğu ↔ arayüz köprüsü (`SaklazHost`): güvenli depo (Keystore), HTTP, QR kamera | Arayüz Chromium'da sahte köprüyle sınandı; gerçek WebView + eklentiler sınanmadı. |
| G3 | WebView'da libsodium (WASM) ve CSP | Chromium'da çalıştı; Android System WebView sürümüne bağlı. |
| G4 | Gerçek Windows kullanıcısında `setup` → `pair` → başlangıç görevi → yeniden başlatma sonrası otomatik bağlanma | CI'da paket + gerçek DPAPI + kasa + veritabanı öz-sınaması ve görev kur/kaldır geçti. Etkileşimli akış ve oturum açılışı sınanmadı. |
| G5 | Terminal QR'ının Windows konsolunda okunabilirliği | Yedek olarak SVG dosyası ve metin kodu var. |
| G6 | Gerçek relay sunucusu (TLS, alan adı) üzerinden akış | Testler yerel relay + PostgreSQL ile yapıldı. Docker imajı CI'da sınanıyor, gerçek sunucuya kurulum yapılmadı. |
| G7 | OpenAI canlı çağrısı | API anahtarı yok. İstek biçimi ve yanıt ayrıştırma birim testli. Model adı (`gpt-5.4-mini`) hesabınızda yoksa ayarlardan değiştirin. |
| G8 | `docker-compose.lan-test.yml` (yerel ağ test kipi) | CI'da sınanmadı. |
| G9 | İki farklı ağdaki (ev/şirket) iki bilgisayarın aynı telefondan yönetimi | Yerelde iki ajanla sınandı (aynı makine). |

## Bilinçli sınırlar (alfa)

| # | Sınır | Etki | Plan |
|---|---|---|---|
| E1 | **Outbox / yeniden gönderim yok** | Noise oturumu sıfırlanırsa o anda gönderilen komut veya sonuç kaybolabilir. Kullanıcı komutu yeniden gönderir. | Sprint 3 A7 |
| E2 | **Politika motoru ve işlem onayı yok** | Bu yüzden yalnızca salt okunur, sabit listedeki komutlar var. Program/dosya/kabuk komutu yok. | Sprint 3 A8 |
| E3 | Acil kilidi açma arayüzü yok | Kilit devredeyken profil komut kabul etmez. Açmak için profil klasörü yeniden kurulmalı. | A8 ile |
| E4 | Sesli komut yok | Arayüzde devre dışı düğme olarak duruyor. | Sonraki sürüm |
| E5 | Sistem bildirimleri yok | Uygulama içi bildirim var. Push için relay'de FCM yapılandırması gerekir. | Sonraki sürüm |
| E6 | APK test (debug) anahtarıyla imzalı; `usesCleartextTraffic=true` (yerel ağ test kipi için) | Mağaza/kurumsal dağıtıma uygun değil. | Kod imzalama kararı (KOD-IMZALAMA-ONERI) |
| E7 | Aynı profil için ikinci telefon / telefon değişimi yok | Telefon değişince alan yeniden oluşturulur, bilgisayarlar yeniden eşleştirilir. | Kurtarma akışı (ADR) |
| E8 | Telefon tarafında tekrar oynatma durumu yerelde; telefon saati çok yanlışsa mesajlar reddedilebilir | Saat farkı toleransı 5 dk | — |
| E9 | Telefonda `pubspec.lock` depoda değil (CI'da üretiliyor, artifact'e ekleniyor) | Bağımlılık sürümleri pubspec'te sabit, geçişli sürümler değil | Flutter ortamı kurulunca kilitlenecek |
| E10 | TPM (A4), rollback sağlamlaştırma (A5), iptal doğrulaması (A6) | Sprint 3 planındaki sıra korunuyor | Sprint 3 |

## Gerçek cihaz test listesi (bu akşam)

- [ ] **Relay:** `curl https://<relay>/readyz` → `{"ok":true}`
- [ ] **Telefon:**
  - [ ] APK kuruluyor ve açılıyor; karanlık arayüz görünüyor
  - [ ] Hesap oluşturuldu; doğrulama uygulamasına eklendi; giriş başarılı; üstte yeşil nokta
  - [ ] Uygulamayı kapatıp açın: alan ve bilgisayarlar duruyor (güvenli depo)
- [ ] **Bilgisayar 1:** `setup` → `pair` → QR kamerayla okundu → iki ekranda güvenlik kodu aynı → `e` → telefonda "eklendi"
- [ ] **Komutlar:**
  - [ ] `sistem`, `disk`, `ağ`, `işlemler` sonuçları geliyor
  - [ ] `format c:` → "izinli değil"
- [ ] **Bilgisayar 2** (farklı ağ): eşleştirme ve komut; telefonda iki bilgisayar ayrı ayrı görünüyor
- [ ] **Başlangıç görevi:**
  - [ ] `install-startup.ps1` → Windows'u yeniden başlatın → telefonda bilgisayar çevrimiçi
  - [ ] Komut çalışıyor
- [ ] **Bağlantı kopması:**
  - [ ] Bilgisayarın ağını kesin → telefonda çevrimdışı görünüyor
  - [ ] Ağ geri gelince kendiliğinden bağlanıyor
  - [ ] Çevrimdışıyken gönderilen komut, bilgisayar gelince çalışıyor
- [ ] **Kurumsal alan:**
  - [ ] Ayrı relay ile ikinci alan eklendi; profil değiştirince diğer alanın cihazları görünmüyor
  - [ ] AI'da bulut kapalı uyarısı çıkıyor
- [ ] **AI:**
  - [ ] OpenAI anahtarı girildi ve yanıt geldi
  - [ ] Anahtar silinince açık hata çıkıyor
  - [ ] Yerel Ollama adresi girildi ve yanıt geldi
- [ ] **Acil kilit:** telefondan gönderildi → bilgisayar komutları reddediyor
- [ ] **İkinci Windows kullanıcısı:** `%LOCALAPPDATA%` dışına kopyalanan `vault.bin` + `kek.bin` başka kullanıcıda açılmıyor
- [ ] **Günlükler:** `agent.log` içinde parola, token, komut çıktısı yok
