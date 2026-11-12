# Sprint 1 Raporu — Temel ve Kriptografi

> **Tarih:** 2026-11-12
> **Durum:** Tamamlandı (aşağıdaki "yapılamayanlar" hariç). **Sprint 2'ye geçilmedi**, proje sahibinin onayı bekleniyor.
> **Ham test çıktısı:** [sprint-1-test-ciktisi.txt](sprint-1-test-ciktisi.txt)

## Önce Bilinmesi Gerekenler

1. **Henüz kullanıcıya görünen bir uygulama yok.** Sprint 1, planda olduğu gibi güvenlik çekirdeğini kurdu: kriptografi ve mesaj protokolü kütüphaneleri. Telefon uygulaması, masaüstü arayüzü ve sunucu sonraki sprintlerde gelecek.
2. **GitHub CI hiç çalışmadı.** Repo erişimi hâlâ yok. Bütün testler bu geliştirme ortamında çalıştırıldı. Sonuçlar gerçek; ancak Windows ve Dart üzerinde koşan işler ilk GitHub çalıştırmasını bekliyor.
3. **Dart (Android) uyumluluk testi yazıldı ama çalıştırılmadı.** Bu ortamda Dart SDK ve pub.dev erişimi engelli.

## 1. Yapılan İşler

| İş | Çıktı |
|---|---|
| Monorepo ve CI kapıları | pnpm + Turborepo, TypeScript strict, ESLint (strictTypeChecked), Vitest, kapsam eşikleri. GitHub Actions: lint, ERP sınır kontrolü, tip, test (Ubuntu **ve** Windows), Dart vektörleri, Pester, gitleaks, CodeQL, Dependabot. Tüm üçüncü taraf eylemler **commit SHA ile sabitlendi**; gitleaks ikilisi sağlama toplamıyla doğrulanıyor. |
| `packages/crypto` | libsodium üzerine ince katman: Ed25519 (alan ayrımlı imzalar), X25519 (düşük dereceli nokta reddi), ChaCha20/XChaCha20-Poly1305, BLAKE2b, HMAC ve HKDF, **Noise_KK durum makinesi**, mühürlü zarf (çevrimdışı alıcı), eşleştirme anahtarları ve 6 haneli SAS. |
| `packages/protocol` | RFC 8785 kanonik JSON (SAKLAZ alt kümesi), katı zod şemaları (bilinmeyen alan reddi), imzalı iç mesaj, **işleme bağlı onay**, **kayan pencereli tekrar oynatma koruması**, sabit sıralı **gelen mesaj doğrulama hattı**, rol yetkileri, **acil kilit** ve **cihaz iptali** mesaj tipleri. |
| Çapraz platform test vektörleri | `packages/protocol/test-vectors/saklaz-v1.json`. Koddaki her değişiklik vektörlerle karşılaştırılır; sapma olursa test kırılır. |
| Dart uyumluluk testi | `apps/mobile/vector_check`: Dart'ta JCS + 7 vektör testi. **Çalıştırılmadı.** |
| Envanter betiği testleri | 8 Pester testi: statik salt okunurluk denetimi, çalışma zamanı, ağ erişimi yokluğu, Windows anlık görüntü testi. |
| Kod imzalama araştırması | [docs/KOD-IMZALAMA-ONERI.md](../KOD-IMZALAMA-ONERI.md). **Satın alma yapılmadı.** |
| Kararlar | ADR-0007, 0008, 0011, 0012 (onayınızı bekliyor). FAZ1-PLAN §16 (şartlarınızın karşılığı ve acil kilit tasarımı). |

## 2. Çalışan Özellikler

Burada "çalışan", otomatik testle doğrulanmış demektir. Bunlar kütüphane düzeyinde özelliklerdir; henüz uçtan uca bir kullanıcı akışı yoktur.

| Özellik | Kanıt |
|---|---|
| Telefon ile bilgisayar arası şifreli oturum (Noise_KK) | **Resmî Noise test vektörüyle birebir eşleşiyor**: el sıkışma, oturum özeti ve 4 şifreli mesaj. |
| Her komutun telefon tarafından imzalanması ve doğrulanması | İmza; başlığı (tip, alıcı, sayaç, zaman, ömür) ve gövdeyi kapsar. Tek bir alan değişirse doğrulama başarısız olur. |
| **Onay, işlemin tamamını kapsar** (isteğiniz) | Özet şunları kapsar: araç, risk, özet metni, tüm hedef dosya ve programlar, tüm parametreler, challenge ve süre. Onaydan sonra bir hedef eklenirse, adım veya araç değişirse ajan çalıştırmayı reddeder (testli). |
| Telefon, gösterilen içerik özetle uyuşmazsa onay ekranını açmaz | Özet metni değiştirilmiş veya hedef listesi kısaltılmış istekler reddedilir. |
| **Eski komutların reddi** (isteğiniz) | Aynı mesaj ikinci kez işlenmez. Pencerenin altında kalan eski sayaç reddedilir. İmzalı ömrü dolan komut reddedilir. |
| **Süresi dolan onayların geçersizliği** (isteğiniz) | Süre ajanın saatiyle ölçülür. Süresi dolan onay geçersiz olur ve bir daha denenemez. |
| Onay tek kullanımlık | Aynı onay ikinci kez kullanılamaz; ret kararı da kaydı tüketir. |
| Ayrı onay anahtarı | Komut anahtarıyla atılmış onay reddedilir (ADR-0011). |
| Rol yetkileri | `viewer` komut veremez. `operator` varsayılan olarak onay veremez ve cihaz iptal edemez, ama acil kilit gönderebilir. |
| Çevrimdışı bilgisayara kuyruklu komut | Komut en çok 72 saat bekleyebilir; imzalı ömür dolunca reddedilir. |
| Eşleştirme | SAS iki tarafta aynıdır. Relay telefonun anahtarını değiştirirse SAS değişir; eşleştirme sırrı olmadan eşleştirme mesajı açılamaz. |
| Yanıltıcı karakter koruması | `rapor‮gpj.exe` gibi yön karakterli ve kontrol karakterli metinler reddedilir. |
| ERP bağımsızlık kuralı | Herhangi bir uygulamanın ASEDEN paketini içe aktarması CI'ı kırar. Kural, bilerek ihlal edilerek doğrulandı. |
| Envanter betiğinin salt okunurluğu (statik ve Linux'ta) | Yalnızca 23 komutluk izin listesindeki komutları çağırıyor, hiçbir yazma komutu yok, ağa yalnızca istenirse çıkıyor. |

## 3. Test Sonuçları

| Paket | Test | Sonuç | Satır kapsamı | Dal kapsamı |
|---|---|---|---|---|
| `@saklaz/crypto` | 34 | ✅ 34 geçti | %99,62 | %95,59 |
| `@saklaz/protocol` | 48 | ✅ 48 geçti | %99,66 | %97,45 |
| Envanter (Pester, Linux PowerShell 7.4.6) | 8 | ✅ 7 geçti, ⏭ 1 atlandı (yalnız Windows) | — | — |
| Dart vektörleri | 7 | ⏸ **Çalıştırılmadı** | — | — |
| Lint / tip denetimi / ERP sınır kontrolü | — | ✅ 0 hata | — | — |
| gitleaks (4 commit) | — | ✅ Sızıntı yok | — | — |

**Toplam:** 82 TypeScript testi ve 7 PowerShell testi geçti. 0 başarısız. 1 atlandı. 7 test çalıştırılmadı (Dart).

**Kullanılan standart test vektörleri:**

| Vektör | Kaynak |
|---|---|
| Noise_KK | Resmî cacophony |
| BLAKE2b | RFC 7693 |
| Ed25519 | RFC 8032 |
| X25519 | RFC 7748 |
| JCS sıralama | RFC 8785 |

**Özellik tabanlı ve kapsamlı testler:**

- Rastgele mesajlarda tek bit değişikliği (200 deneme): hepsi reddedildi.
- Rastgele bayt dizileri doğrulayıcıya verildi (500 deneme): hepsi reddedildi.
- Sayaç dizileri: hiçbir sayaç iki kez "yeni" kabul edilmedi.
- **Kapsamlı mutasyon testi:** Geçerli bir komutun her karakteri, her yazdırılabilir karakterle değiştirildi. **197.880 mutasyonun 0'ı kabul edildi; tipsiz hata sayısı 0.**

## 4. Güvenlik Testleri

| Kontrol | Sprint 1 durumu | Eksik olan |
|---|---|---|
| S3 Uçtan uca şifreleme | 🟨 Noise_KK resmî vektörle doğrulandı. Sahte statik anahtar, farklı önsöz, bit değişikliği ve tekrar oynatma reddediliyor. | Relay üzerinden "düz metin yok" testi (Sprint 2) |
| S4 Yalnız imzalı komut | 🟨 Protokol düzeyinde testli | Ajan entegrasyonu (Sprint 2–3) |
| S5 Tekrar oynatma koruması | 🟨 Kayan pencere ve imzalı ömür testli | Kalıcı depo (Sprint 2) |
| S6 İşleme bağlı onay | 🟨 11 test | Telefon arayüzü ve araç entegrasyonu (Sprint 3–4) |
| S13 Çapraz platform vektörleri | 🟨 TS tarafı ve sapma testi hazır | **Dart testi çalıştırılmadı** |
| S16 Ele geçirilmiş relay | 🟨 6 senaryo, 5 testte doğrulandı | Gerçek relay ile entegrasyon (Sprint 5) |

S16 kapsamındaki 6 senaryo (son ikisi aynı testte):

1. Relay kendi anahtarıyla telefon adına komut imzalayamaz.
2. Relay kendi kimliğiyle komut gönderemez.
3. Relay eski bir komutu yeniden çalıştıramaz.
4. Relay başka bir bilgisayara giden komutu bu bilgisayara yönlendiremez.
5. Relay bir komutun ömrünü uzatamaz.
6. Relay bir komutun tipini değiştiremez.

**Hiçbir kontrol ✅ olarak işaretlenmedi.** ✅, kontrolün tamamen uygulanmasını ve GitHub CI'da geçmesini gerektirir.

## 5. Bilinen Hatalar ve Sınırlar

### 5.1 Sprint içinde bulunup düzeltilenler

Rapor yazılırken yapılan öz denetimde, "ele geçirilmiş relay" grubundaki bir testin (`agentId sabittir`) yalnızca bir metnin önekini kontrol ettiği ve hiçbir şey kanıtlamadığı görüldü. Bu test kaldırıldı ve sayılara dahil edilmedi.

| # | Sorun | Nasıl bulundu | Düzeltme |
|---|---|---|---|
| H1 | Kanonik olmayan base64 imza, doğrulayıcıda tipli `ProtocolError` yerine `CryptoError` fırlatıyordu. Mesaj yine reddediliyordu, yani güvenlik açığı değildi. Ancak "her ret tiplidir" sözleşmesini bozuyordu. | Özellik tabanlı test (fast-check) | Şema düzeyinde kanonik base64 denetimi eklendi. Regresyon testi ve 197.880 mutasyonluk kapsamlı test geçti. |
| H2 | `libsodium-wrappers-sumo` 0.7.16 ESM paketinde eksik dosya vardı; paket yüklenemiyordu. | İlk test çalıştırması | 0.8.4'e yükseltildi (ADR-0008). |
| H3 | `pnpm-lock.yaml`, kesin sürüme sabitlenen bağımlılıklarla uyuşmuyordu. | `--frozen-lockfile` kontrolü | Kilit dosyası yenilendi; temiz kurulumla doğrulandı. |

### 5.2 Açık sınırlar ve yapılamayanlar

| # | Konu | Etki | Plan |
|---|---|---|---|
| A1 | **Dart uyumluluk testi çalıştırılmadı** (ortamda Dart SDK ve pub.dev engelli) | Android'in aynı imzaları üreteceği henüz kanıtlanmadı | GitHub CI'da veya Dart erişimli ortamda ilk iş olarak çalıştırılacak |
| A2 | **GitHub CI hiç çalışmadı** (repo erişimi yok) | Windows üzerindeki TS testleri ve Pester anlık görüntü testi koşmadı | Repo erişimi açılınca |
| A3 | Envanter betiğinin **gerçek Windows'ta** testi yapılmadı. Linux'ta Windows komutları bulunmadığı için JSON'daki alanlar "HATA" değeri taşıyor; bu Linux'ta beklenen bir durum. | Betik ✅ değil | CI windows-2022 işi ve IT gözetiminde gerçek bir bilgisayar |
| A4 | Tekrar oynatma ve onay kayıtları şimdilik bellekte tutuluyor | Ajan yeniden başlarsa sayaç durumu kaybolur. Henüz ajan olmadığı için etkisi yok. | Sprint 2: SQLite kalıcı depo, mesaj işlenmeden **önce** yazma |
| A5 | Noise durum makinesi bizim yazdığımız bir kod (~250 satır) | Resmî vektör geçiyor, ancak bağımsız bir uzman incelemesi yapılmadı | Faz 4 öncesi harici kripto incelemesi (ADR-0008) |
| A6 | HKDF (RFC 5869, HMAC-BLAKE2b) için resmî bir vektör yok | Aynı HMAC yapısı Noise vektörüyle dolaylı olarak doğrulandı | Dart tarafıyla çapraz kontrol (vektör dosyasında hazır) |
| A7 | Telefon saati 5 dakikadan fazla ileri giderse komutlar reddedilir (`TS_IN_FUTURE`) | Bilinçli bir güvenlik davranışı; kullanıcıya anlaşılır mesaj gösterilmesi gerekiyor | Sprint 4: telefonda saat uyarısı |
| A8 | JavaScript'te gizli anahtarların bellekten silinmesi "en iyi çaba"dır (çöp toplayıcının kopyaları olabilir) | Bilinen bir platform sınırı | Uzun ömürlü anahtarlar DPAPI ve Keystore'da tutulur |
| A9 | Mühürlü zarfta ileri gizlilik sınırlı | Kabul edildi (ADR-0007) | Faz 4'te ön anahtar seçeneği değerlendirilecek |

## 6. Sonraki Sprintin (Sprint 2) Gereksinimleri

### 6.1 Sizden beklenen kararlar ve erişimler

| # | Konu | Neden |
|---|---|---|
| 1 | **Sprint 2'ye geçiş onayı** | Talimatınız gereği beklemedeyim |
| 2 | **GitHub repo erişimi** (claude.ai → Ayarlar → Connectors → GitHub, `SAKLAZ5341/SAKLAZ-A-BUS-NESS`'e izin) | CI'ın ilk çalışması: Windows testleri, Dart ve Pester |
| 3 | **Geliştirme ortamı alan adı izinleri** (claude.ai → Ayarlar → Capabilities): `pub.dev`, `storage.googleapis.com`; isteğe bağlı olarak `www.powershellgallery.com` | Dart testi ve Dart kripto kütüphanesi kararı (ADR-0008). Alternatif: kararı GitHub CI üzerinden vermek |
| 4 | **ADR 0007, 0008, 0011, 0012** için onay veya itiraz | Sprint 2 bu kararların üzerine kuruluyor |
| 5 | **Kod imzalama soruları** ([öneri belgesi §5](../KOD-IMZALAMA-ONERI.md)): AB tüzel kişiliği var mı, dağıtım yalnızca şirket içi mi, EV şartı var mı, kimler imzalama yetkilisi olacak | Sertifika doğrulaması haftalar sürebilir; karar Sprint 2 içinde verilmeli |
| 6 | Envanter betiğinin IT gözetiminde bir şirket bilgisayarında çalıştırılması | Karar D6 |

### 6.2 Sprint 2 kapsamı (FAZ1-PLAN §13 ve §16.5)

**Relay sunucusu**
- Hesap ve MFA
- Cihaz kaydı
- WSS yönlendirme ve süreli kuyruk
- Çevrimiçi durumu (presence)
- Meta veri denetim kaydı
- Docker Compose ile kurulum

**Ajan**
- Transport (giden WSS, yeniden bağlanma, outbox)
- `IncomingVerifier` entegrasyonu
- **SQLite kalıcı depo** (sayaç ve onay)
- Hash zincirli denetim kaydı

**Eşleştirme**
- Uçtan uca eşleştirme: ajan ve TS test istemcisi (QR + SAS)

**Acil durum**
- **Acil kilit:** bağlantı kesme, kalıcı kilit, kuyruktan gelen kilidin ilk iş olarak uygulanması
- **Yerel ve uzaktan cihaz iptali**

**Testler (S2–S5)**
- Simüle telefonla eşleştirme
- Relay üzerinden düz metin bulunmadığının testi

**Kararlar**
- Dart kripto kütüphanesi kararı (ADR-0008)

### 6.3 Ortam

- Relay testleri için PostgreSQL 16 ikilileri bu ortamda mevcut (Faz 0'da kullanıldı).
- Docker gerekmeden yerel test yapılabilir. Docker Compose dosyası CI'da doğrulanacak.
