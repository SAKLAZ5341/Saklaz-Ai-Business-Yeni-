# Sprint 2 Raporu — Relay, Eşleştirme, Cihaz Listesi, Ajan Güvenlik Çekirdeği

> **Tarih:** 2026-11-12
> **Durum:** Tamamlandı. Aşağıdaki "Eksikler" bölümünde listelenen maddeler bu sprintte yapılmadı. **Sprint 3'e geçilmedi**; proje sahibinin onayı bekleniyor.
> **Ham test çıktısı:** [sprint-2-test-ciktisi.txt](sprint-2-test-ciktisi.txt)
> Bu rapordaki güvenlik ifadeleri SECURITY.md §0'daki varsayımlar altında geçerlidir. Hiçbiri mutlak değildir.

## Önce Bilinmesi Gerekenler

1. **Telefonda veya masaüstünde hâlâ kullanıcıya görünen bir uygulama yok.**
   - Bu sprintte relay sunucusu, Windows ajanının güvenlik çekirdeği ve protokolün v0.3 eklemeleri yapıldı.
   - Telefon tarafı, Android uygulamasının protokol davranışını taklit eden bir **TypeScript simülatörüyle** sınandı.
   - Gerçek Android uygulaması Sprint 4'tedir.
2. **Komutlar doğrulanıyor ama çalıştırılmıyor.** İmzalı bir komut ajana ulaşıyor, doğrulanıyor, kaydediliyor ve telefona imzalı "alındı" yanıtı dönüyor. Komutun gerçekten yürütülmesi (Excel özeti vb.) Sprint 3'tedir.
3. **Hiçbir şey gerçek bir Windows bilgisayarda, gerçek bir telefonda veya GitHub CI'da çalışmadı.** Tüm testler bu Linux geliştirme ortamında çalıştı (§5).

## 1. Çalışan Özellikler

Burada "çalışan", otomatik testle doğrulanmış demektir.

### 1.1 Relay sunucusu (kör aktarıcı)

| Özellik | Kanıt |
|---|---|
| Hesap: Argon2id parola, **zorunlu TOTP** | RFC 6238 test vektörleri; parola veya kod yanlışsa aynı, ayrıntısız hata döner |
| Kaba kuvvet kilidi ve IP hız sınırı | Art arda hatalı girişler hesabı kilitliyor (423); dakikalık sınır aşılınca 429 |
| Kısa ömürlü erişim token'ı ve dönen yenileme token'ı | Kullanılmış yenileme token'ı tekrar gelirse **tüm token ailesi iptal ediliyor** |
| Cihaz kaydında anahtar sahipliği kanıtı | Kanıtsız veya yanlış kanıtlı kayıt reddediliyor |
| Bağlantıda iki katmanlı kimlik doğrulama: token + cihaz anahtarıyla imzalı meydan okuma | Yanlış anahtar, başka hesabın token'ı ve kimlik doğrulamadan önce gönderilen çerçeve reddediliyor |
| Yalnızca aynı hesaptaki cihazlara yönlendirme | Başka hesaba gönderim reddediliyor |
| Süreli kuyruk, teslim onayıyla silme, süresi dolan zarfların temizlenmesi | Testli |
| Çevrimdışı cihaz için **içeriksiz** uyandırma | Yalnızca cihaz kimliği aktarılıyor (gerçek FCM bağlantısı Sprint 4'te) |
| Hız sınırı (bağlantı başına) | Aşan bağlantı kapatılıyor |
| Meta veri denetim kaydı: hash zinciri, **veritabanı tetikleyicisiyle yalnızca ekleme** | UPDATE ve DELETE veritabanında reddediliyor; kayıtta içerik bulunmuyor |
| Giriş noktası gerçek bir süreç olarak | Gizli bilgileri dosyadan okudu, gerçek PostgreSQL'i kurdu, sağlık kontrolü ve kayıt çalıştı, güvenlik başlıkları geldi |

### 1.2 Ajan güvenlik çekirdeği

| Özellik | Kanıt |
|---|---|
| **Şifreli yerel veritabanı** (SQLCipher), anahtar kasada | Dosyada düz metin yok; yanlış anahtarla açılmıyor |
| **Eşleştirme:** QR + SAS + eklenen cihazın eş-imzası | Başarılı akış; SAS uyuşmazlığı; eşleştirme sırrını bilmeyen biri (ör. relay); başka anahtar; süre aşımı (5 test) |
| **Acil kilit:** kalıcı, yalnızca yerelde açılıyor | Telefondan kilit → bağlantı kesiliyor; yeniden başlatmada kilit sürüyor; yerel doğrulama olmadan açılmıyor |
| **Kuyruktaki acil kilit ilk iş uygulanıyor** | Kendisinden önce kuyruğa girmiş iki komut çalışmıyor. Gerçek relay ve gerçek kuyrukla da doğrulandı. |
| Yerel acil kilit (sunucudan bağımsız) | Testli |
| **Geri yükleme (rollback) koruması** | **Gerçek veritabanı dosyasının eski bir kopyası geri yüklendi**; yedekten sonra işlenmiş komut, aynı şifreli çerçeveyle yeniden oynatıldığında reddedildi. Geri yükleme yoksa aynı çerçeve "yinelenen" olarak tanınıyor. |
| **İptal edilmiş cihazın anahtarlarının yeniden kullanılamaması** | Aynı kimlik, yeni kimlik + eski anahtarlar veya eski anahtarlardan **yalnızca biri** reddediliyor |
| Sahip imzalı iptal sonrası iptal edilen telefonun reddi | Testli |
| Yerel engelleme (listeden ve sunucudan bağımsız) | Testli |
| Hash zincirli denetim kaydı | Bir satır değiştirildiğinde bozulma tespit ediliyor |
| Liste geride kaldığında eksik girişleri imzalı mesajla isteme | Testli |
| Relay istemcisi | Toplu teslim, **işlendikten sonra** teslim onayı, hata durumunda onay gönderilmemesi, yeniden bağlanma, kilit sonrası yeniden bağlanmama |

### 1.3 Protokol v0.3 (güvenlik çekirdeği korundu)

| Özellik | Kanıt |
|---|---|
| **İmzalı cihaz listesi** | Zincir doğrulama; sahte imza, bilinmeyen imzalayan, komut anahtarıyla imza (biyometrik onay anahtarı şartı), eş-imzasız ekleme, son sahibin iptali ve çatallanma reddediliyor |
| **Cihazlar arası ayrı güven bağları** | Aynı telefon bir bilgisayarda owner, diğerinde viewer olabiliyor; bağı olmayan bilgisayara komut gönderemiyor |
| **Çalışma alanı izolasyonu** | Başka alana ait imzalı mesaj reddediliyor; onay özeti alanı kapsıyor |
| Liste güncelliği (`rh`) | Geride kalan alıcı mesajı işlemiyor; uyuşmayan özet çatallanma olarak reddediliyor |
| **Uçtan uca kanal**: Noise_KK oturumu + mühürlü zarf yedeği | Eşzamanlı başlatma çakışması, oturum süresi dolumu, kayıp mesajda oturumun sıfırlanması, **yinelenen teslime dayanıklılık** |
| Kripto çekirdeği | Yalnızca 3 imza alanı eklendi (roster, recovery, relay-auth); başka değişiklik yok |

## 2. Testler

| Paket | Test | Sonuç | Satır kapsamı | Dal kapsamı |
|---|---|---|---|---|
| `@saklaz/crypto` | 34 | ✅ 34 geçti | %99,63 | %95,59 |
| `@saklaz/protocol` | 88 | ✅ 88 geçti | %98,88 | %96,33 |
| `@saklaz/agent` | 23 | ✅ 23 geçti | %93,93 | %86,06 |
| `@saklaz/relay` (gerçek PostgreSQL 16, gerçek WSS) | 21 | ✅ 21 geçti | %86,12 | %79,31 |
| Envanter betiği (Pester, Linux) | 8 | ✅ 7 geçti, ⏭ 1 atlandı (yalnız Windows) | — | — |
| Dart vektörleri | 7 | ⏸ **Çalıştırılmadı** (ortamda Dart yok) | — | — |
| Lint, tip denetimi, sınır kontrolü, gitleaks | — | ✅ 0 hata, sızıntı yok | — | — |

**Toplam:** 166 TypeScript testi ve 7 PowerShell testi geçti. 0 başarısız.

**Ek doğrulamalar:**

- **Kapsamlı mutasyon testi (v0.3 doğrulayıcı):** Geçerli bir komutun her karakteri, her yazdırılabilir karakterle değiştirildi. **146.928 mutasyonun 0'ı kabul edildi; tipsiz hata sayısı 0.**
- **Kararlılık:** Ağ ağırlıklı relay ve ajan paketleri üst üste 3 kez çalıştırıldı; her seferinde tüm testler geçti.
- **Sınır kontrolünün kendisi:** Test simülatörünün üretim koduna içe aktarılması ve ERP içe aktarması bilerek denendi; ikisi de CI'ı kırdı.

## 3. Güvenlik Açıkları

### 3.1 Sprint içinde bulunup düzeltilenler

Bulunan sorunların hiçbiri gizlilik veya bütünlük ihlali değildi. Her durumda imza ve şifreleme katmanları bozuk veriyi reddetti. Sorunlar **kullanılabilirlik ve dayanıklılık** açıklarıydı. Ancak gerçek kullanımda komutların sessizce kaybolmasına yol açacaklardı.

| # | Sorun | Nasıl bulundu | Düzeltme |
|---|---|---|---|
| G1 | **Relay, aynı bağlantıdan gelen çerçeveleri eşzamanlı işliyordu.** Bir el sıkışma yanıtı ile arkasından gelen şifreli mesaj kuyruğa ters sırada yazılabiliyordu; Noise mesajı kayboluyordu. | Uçtan uca test (zamanlamaya bağlı) | Bağlantı başına sıralı işleme |
| G2 | **Relay aynı zarfı aynı bağlantıda iki kez teslim ediyordu.** İkinci el sıkışma ajanın oturumunu farklı anahtarlarla yeniden kuruyordu; sonraki mesajlar telefonda çözülemiyordu. | Uçtan uca test + teşhis kaydı | Relay'de "yolda olan zarf" takibi |
| G3 | Uçtan uca kanal, meşru yinelenen teslime dayanıklı değildi. Relay, yeniden bağlanma sonrası en az bir kez teslim eder. | G2'nin kök neden analizi | Yinelenen el sıkışmaya önceki yanıt tekrarlanıyor; yinelenen şifreli mesaj yok sayılıyor (testli) |
| G4 | Eşleştirmede, telefonun bilgisayara verdiği **görünen ad** da karşılaştırılıyordu. Farklı ad verilince eşleştirme başarısız oluyordu. | Uçtan uca test | Yalnızca güvenlikle ilgili alanlar karşılaştırılıyor: tür, kimlik, anahtarlar |
| G5 | Testlerde WebSocket yükünün metne çevrilmesi yanlış olabiliyordu (`[object Object]`). | Lint (otomatik düzeltmenin yan etkisi) | Doğru çözümleme yardımcısı |

### 3.2 Açık güvenlik riskleri ve sınırlar

| # | Konu | Ciddiyet | Durum ve önlem |
|---|---|---|---|
| A1 | **Sunucu bir iptal girişini iletmezse**, iptal edilmiş telefon komut göndermeye devam edebilir. Bu, uçtan uca testle **gösterildi**. | Yüksek (iki ihlal gerektirir: sunucu ele geçirilmesi + çalınan ve biyometrisi aşılan telefon) | **Önlemler:** (1) Yerel engelleme ve yerel kilit anında çalışır. (2) Sahibin bir sonraki meşru mesajındaki `rh`, ajanın geride olduğunu ortaya çıkarır ve iptal uygulanır; bu da testle gösterildi. **Tam olarak ortadan kaldırılamaz** (SECURITY.md §21). |
| A2 | **Windows güvenli kasası (DPAPI) henüz yok.** Ajan şu an yalnızca bellek veya **güvensiz dosya** kasasıyla çalışıyor. | Yüksek (üretim engeli) | Sprint 3: Windows CI'da doğrulanarak eklenecek. O zamana kadar ajan **üretimde kullanılamaz**. |
| A3 | Rollback koruması, veritabanı ve kasa **birlikte** eski haline döndürülürse aşılabilir. | Orta | Yerel yönetici yetkisi gerektirir (uç cihazın ele geçirilmesi, V4) |
| A4 | **TOTP kodu, geçerlilik penceresi içinde (±30 sn) tekrar kullanılabilir.** Kullanılmış kodlar izlenmiyor. | Düşük–orta | RFC 6238 tekrar kullanımın engellenmesini önerir. **Sprint 3'te düzeltilecek.** |
| A5 | Ajandan telefona giden yanıtlar (ack, olaylar) kalıcı bir outbox ile yeniden gönderilmiyor. | Orta (kullanılabilirlik) | Görev sistemiyle birlikte Sprint 3'te |
| A6 | Relay kuyruğunda cihaz başına yalnızca **adet** sınırı var; toplam boyut sınırı yok. | Orta (hizmet engelleme) | Sprint 5 sağlamlaştırma |
| A7 | Erişim token'ları 10 dakika boyunca iptal edilemez. | Düşük | Kabul edildi; relay erişimi komut yetkisi vermez |
| A8 | Ajanın kendi uçtan uca kanal çerçevelerinin boyut sınırı relay'e bağlı (400 KB). | Düşük | Sprint 5 fuzz testleri |
| A9 | **Bağımsız güvenlik incelemesi yapılmadı.** Noise durum makinesi, cihaz listesi ve doğrulama hattı bizim kodumuzdur. | — | Faz 4 öncesi harici inceleme (V3) |

## 4. Eksikler (bu sprintte yapılmayanlar)

| Madde | Neden | Ne zaman |
|---|---|---|
| **Dart kriptografi kütüphanesi kararı** (ADR-0008) ve Dart test vektörleri | Ortamda Dart SDK ve pub.dev erişimi engelli | GitHub CI ilk çalışınca veya alan adı izni verilince |
| Windows DPAPI kasası | Linux ortamında doğrulanamaz; doğrulanmamış güvenlik kodu yazmak istemedim | Sprint 3 (Windows CI) |
| Yerel kimlik doğrulama (Windows Hello / PIN) | Arayüz Sprint 4'te; şimdilik yalnızca test arayüzü var | Sprint 4 |
| Gerçek FCM bağlantısı | Firebase projesi gerekli (H5) | Sprint 4 |
| **Docker kurulumu** | Ortamda Docker daemon yok. Dockerfile'da **bilinen bir eksik** var: üretim derleme adımı yok; bu haliyle başlamaz (dosyada yazılı). | Sprint 5 |
| Ek telefonun QR ile eşleşmesi (yedek cihaz akışı) | Protokol ve liste destekliyor; arayüz akışı Sprint 4–6'da | Sprint 4/6 |
| Komut yürütme, `history.query` yanıtı | Görev sistemi Sprint 3'te | Sprint 3 |
| Kurtarma işlemleri (`recovery.*`) | Plan gereği | Sprint 6 (bağımsız test şartlı) |
| Android Keystore attestation doğrulaması | Android uygulaması yok | Sprint 4 |

## 5. Gerçek Cihazlarda Doğrulanmamış Konular

| Alan | Doğrulanmamış olan |
|---|---|
| **Windows** | SQLCipher yerel modülünün Windows'ta yüklenmesi; dosya yolları ve izinler; envanter betiğinin değişiklik yapmadığını kanıtlayan anlık görüntü testi; Windows CI işinin kendisi (hiç çalışmadı) |
| **Android** | Uygulamanın tamamı (henüz yok). Keystore/StrongBox, biyometri, iş profili (Work Profile), Dart'ın aynı imzaları üretmesi. |
| **Ağ** | Gerçek internet gecikmesi, NAT, şirket proxy'si/güvenlik duvarı, Caddy üzerinden TLS 1.3, kişisel VPS. Testler aynı makinede 127.0.0.1 üzerinden yapıldı. |
| **Ölçek** | 50 eşzamanlı cihaz, büyük kuyruklar, uzun süreli bağlantılar (yük testi Sprint 5) |
| **Dağıtım** | Docker Compose, gizli dosyalar, iç ağ izolasyonu, otomatik güncellemeler |
| **GitHub CI** | Hiçbir iş çalışmadı (repo erişimi yok) |

## 6. Sunucunun Mesajları Geciktirmesi veya Engellemesi (S23)

Proje sahibinin şartı gereği ayrı başlık. Testlerde gözlenenler:

| Senaryo | Güvenliğe etkisi | Kullanılabilirliğe etkisi | Test |
|---|---|---|---|
| Relay bir şifreli oturum mesajını düşürüyor | Yok: sonraki mesaj çözülemiyor, kabul edilmiyor | Oturum sıfırlanıyor; telefon yeniden gönderince işlem yapılıyor | Ajan testi + uçtan uca test |
| Relay aynı mesajı yeniden iletiyor | Yok: yineleme tanınıyor, iki kez işlenmiyor | Yok (G2/G3 düzeltmesinden sonra) | Protokol + uçtan uca |
| Relay mesajları geciktiriyor (kuyruk) | Ömrü dolan komut çalışmıyor; acil kilit kendisinden önceki komutlardan önce uygulanıyor | Görev gecikiyor | Ajan + uçtan uca |
| **Relay iptal girişini iletmiyor** | **İptal edilen telefon geçici olarak kullanılabilir (A1)** | — | Uçtan uca: risk ve önlem birlikte gösterildi |
| Relay sahte zarf ekliyor | Yok: zarf çözülemiyor, reddediliyor | Yok | Uçtan uca |
| Relay tamamen kapalı | Yok: yerel kullanım sürüyor | Uzaktan erişim yok | Kapsam dışı (beklenen davranış) |

## 7. Sonraki Sprintin (Sprint 3) Gereksinimleri

### 7.1 Sizden beklenenler

| # | Konu |
|---|---|
| 1 | **Sprint 3'e geçiş onayı** |
| 2 | **GitHub repo erişimi.** Windows CI işi (DPAPI, SQLCipher), PostgreSQL servisli testler ve Dart testleri ancak bu şekilde ilk kez çalışır. Sprint 3'ün DPAPI kısmı buna bağlıdır. |
| 3 | Alan adı izni (Ayarlar → Capabilities): `pub.dev` ve `storage.googleapis.com`. Ya da Dart kararını GitHub CI'a bırakma onayı. |
| 4 | Sprint 1'den bekleyen **kod imzalama soruları** (KOD-IMZALAMA-ONERI.md §5) |
| 5 | Envanter betiğinin IT gözetiminde bir şirket bilgisayarında çalıştırılması (D6) |

### 7.2 Sprint 3 kapsamı (FAZ1-PLAN §13)

| Alan | İş |
|---|---|
| Ajan | Orkestratör, politika motoru, yetenek ve klasör izinleri, worker havuzu, Faz 1 araçları (dosya, Excel, PDF, Word okuma; rapor üretme), RuleEngine, DataGuard, Excel/Raporlama ve Kişisel Asistan ajanları |
| İşleme bağlı onay | Araçlara bağlanması (`assertExecutionMatches`) |
| Kasa | **Windows DPAPI kasası** (A2) |
| Açık güvenlik maddeleri | Ajan outbox'ı (A5), TOTP tekrar kullanım koruması (A4) |
| Test verisi | Yalnızca sentetik (`SAKLAZ-TEST`) |
