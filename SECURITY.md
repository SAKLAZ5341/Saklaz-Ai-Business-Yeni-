# SAKLAZ AI — Güvenlik Modeli

> **Sürüm:** v0.2 (Faz 0), 2026-11-12
> **Durum:** Taslak. Aşağıdaki kontrollerin hiçbiri henüz uygulanmadı. Her kontrol, otomatik testi CI'da geçtiğinde §15'teki tabloda ✅ olarak işaretlenecek.

## 1. Güvenlik Hedefleri

| # | Hedef | Kaynak |
|---|---|---|
| G1 | Şirket dosyaları ve ASEDEN verisi izinsiz olarak Windows makinesinden çıkmaz. Hiçbir koşulda düz metin olarak çıkmaz. | K1, K3 |
| G2 | Relay sunucusu, taşıdığı içeriği okuyamaz. | K2, K4 |
| G3 | Relay sunucusu tamamen ele geçirilse bile ajana komut çalıştıramaz, onay sahteleyemez ve kritik işlem yaptıramaz. | K5 |
| G4 | Her kritik işlem, yetkili kişinin kendi cihazında verdiği ve kriptografik olarak doğrulanan bir onaya dayanır. | K6 |
| G5 | Canlı ASEDEN verisi hiçbir koşulda değiştirilmez. Keşif yalnızca katalog düzeyindedir. | K8 |
| G6 | Her önemli olay inkâr edilemez ve kurcalanması tespit edilebilir biçimde kaydedilir. | — |

## 2. Korunan Varlıklar

| Varlık | Konum | Hassasiyet |
|---|---|---|
| ASEDEN verisi (sipariş, tedarikçi, fiyat, stok) | ASEDEN, ajan önbelleği | Yüksek (ticari sır) |
| AS9100 kayıtları | ASEDEN, yerel dosyalar | Yüksek (denetim ve müşteri yükümlülüğü) |
| Şirket dosyaları | Windows makine | Yüksek |
| Cihaz özel anahtarları | Android Keystore, Windows DPAPI | **Kritik.** Güvenliğin kökü bu anahtarlardır. |
| Hesap kimlik bilgileri ve MFA sırları | Relay DB | Yüksek. Relay'e erişim sağlar, komut yetkisi vermez. |
| Denetim kayıtları | Ajan (içerik), relay (meta veri) | Yüksek (bütünlük önemli) |

## 3. Güven Modeli

```
Güvenilen (güven kökü):       Telefonun Ed25519 anahtarı (Keystore + biyometrik)
                              Windows ajanının anahtarı (DPAPI) ve ajan yazılımı
                              Eşleştirmede sabitlenen açık anahtarlar
Güvenilmeyen:                 Relay sunucusu, ağ, push servisi (FCM),
                              dosya/e-posta/web/ERP içeriği (prompt injection kaynağı),
                              AI modellerinin önerileri
```

**Temel ilke:** Ajan, bir mesajı içeriğine göre değil, **kimin imzaladığına** göre değerlendirir. Relay'in söylediği hiçbir şey, örneğin "bu cihaz artık yetkili" veya "bu anahtar güncellendi", ajanın davranışını değiştirmez.

### 3.1 Relay ele geçirilirse

| Saldırganın yapabileceği | Yapamayacağı |
|---|---|
| Hizmeti durdurmak (DoS), mesajları geciktirmek veya düşürmek | Mesaj içeriğini okumak (E2EE) |
| Meta veriyi görmek: kim, ne zaman, ne boyutta | Ajana komut göndermek (telefon imzası yok) |
| Eski şifreli mesajları tekrar göndermek | Tekrar gönderimle işlem yaptırmak (sayaç ve nonce reddeder) |
| Sahte cihaz açık anahtarı yayınlamak | Ajanı buna inandırmak (anahtarlar eşleştirmede sabitlenmiştir) |
| Relay hesap parolalarının hash'lerini çalmak | Bu parolalarla komut vermek (komut için cihaz anahtarı gerekir) |
| Sahte push bildirimi göndermek | Sahte bildirimle onay almak (onay ekranı içeriği E2EE kanaldan gelir, ajan imzalıdır) |

**Kalan risk:** Hizmet kesintisi ve meta veri sızıntısı. Bunlar kabul edilir ve izlenir. Ayrıca ele geçirilmiş bir relay, yeni bir eşleştirme oturumu başlatmaya çalışabilir. Eşleştirme fiziksel QR ve iki ekranda karşılaştırma gerektirdiğinden bu saldırı başarısız olur (§4).

### 3.2 Diğer senaryolar

| Senaryo | Etki | Önlem |
|---|---|---|
| Telefon çalındı (kilitli) | Düşük | Keystore anahtarı biyometrik doğrulama olmadan kullanılamaz. Cihaz Windows'tan yerel olarak iptal edilebilir. |
| Telefon çalındı (kilidi açık, saldırgan biyometriyi geçebiliyor) | Yüksek | Kritik işlemler kısa süreli onay penceresinde gerçekleşir. Günlük işlem limitleri vardır. Kullanıcı Windows'tan ve ikinci cihazdan iptal edebilir. |
| Windows makine ele geçirildi (yönetici yetkisiyle) | Yüksek | Bu kapsam dışıdır. Uç nokta güvenliği (EDR, BitLocker) şirket IT'nin sorumluluğundadır. Ajan SYSTEM yetkisinde çalışmadığı için yeni bir yetki kazandırmaz. |
| Kötü amaçlı güncelleme (tedarik zinciri saldırısı) | Kritik | Güncellemeler kod imzalıdır ve ajan, sabitlenmiş yayın anahtarıyla imzayı doğrular. Güncelleme kanalı relay'den ayrıdır. Derleme tekrarlanabilir ve bağımlılıklar kilitlidir. |
| Prompt injection (dosya veya e-posta içindeki talimat) | Yüksek | İçerik veri olarak işlenir. Araç çağrısını model değil politika motoru yapar. Kritik işlem insan onayı gerektirir (§11). |

## 4. Cihaz Eşleştirme (relay'e güvenmeden)

**Amaç:** Telefon ile ajanın birbirinin açık anahtarını, relay ortada adam (MITM) olsa bile doğru öğrenmesi.

1. Kullanıcı Windows'ta "Telefon Eşleştir"e basar. Ajan şunları üretir:
   - Kendi kalıcı anahtarları (ilk kurulumda bir kez): Ed25519 imza anahtarı ve X25519 DH anahtarı.
   - Tek kullanımlık, 5 dakika geçerli, 256 bit rastgele bir **eşleştirme sırrı** `S`.
2. Ajan ekranda bir QR kodu gösterir. QR şunları içerir: `{relayUrl, agentDeviceId, agentSignPub, agentDhPub, S, expiresAt}`. Bu QR yalnızca ekranda görünür; `S` relay'e hiçbir zaman gönderilmez.
3. Telefon QR'ı okur ve kendi anahtarlarını üretir (Keystore, biyometriye bağlı).
4. Telefon `{phoneSignPub, phoneDhPub}` bilgisini, `HKDF(S)` ile türetilmiş anahtarla şifrelenmiş ve kimliği doğrulanmış (AEAD) olarak relay üzerinden ajana gönderir. Relay `S`'i bilmediği için bu mesajı ne okuyabilir ne de değiştirebilir.
5. İki taraf, her iki açık anahtar seti ve `S` üzerinden 6 haneli bir **Kısa Doğrulama Dizisi (SAS)** hesaplar. Bu dizi iki ekranda gösterilir. Kullanıcı dizilerin aynı olduğunu her iki cihazda onaylar.
6. Ajan telefonun anahtarlarını `paired_devices` tablosuna, telefon da ajanın anahtarlarını kendi yerel deposuna sabitler.

Ek kurallar:

- **İkinci telefon:** İkinci bir telefon eklemek için hem yukarıdaki fiziksel QR akışı hem de mevcut telefonun onayı gerekir. Mevcut telefon yoksa Windows'ta yerel yönetici onayı yeterlidir.
- **Eşleştirmenin kalıcılığı:** Sunucu tarafında "eşleştirmeyi kaldır" düğmesi yoktur. Eşleştirmeyi yalnızca cihazlar kaldırabilir.

## 5. Uçtan Uca Şifreleme

### 5.1 Oturum

- **Protokol:** `Noise_KK_25519_ChaChaPoly_BLAKE2s`. İki taraf da birbirinin statik X25519 anahtarını eşleştirmeden bilir. Bu sayede sunucu sahte bir taraf olarak araya giremez.
- **İleri gizlilik:** Her oturumda geçici (ephemeral) anahtarlar kullanılır. Bu sayede bir anahtar sonradan ele geçirilse bile geçmiş trafik çözülemez.
- **Oturum yenileme:** Oturum 24 saatte bir veya 10.000 mesajda bir yenilenir; hangisi önce olursa.
- **Çevrimdışı alıcı:** Alıcı çevrimdışıyken gönderilen mesajlar için Noise oturumu kurulamaz. Bu durumda kullanılan şema şudur:
  1. Gönderen, alıcının statik X25519 açık anahtarına karşı tek seferlik bir geçici X25519 anahtarı üretir ve bir mühürlü zarf (sealed-box benzeri) oluşturur.
  2. Zarfın içeriği Ed25519 ile imzalanır.
  3. Bu yol sınırlı ileri gizlilik sağlar. Kabul edilmiş bir ödünleşimdir ve Faz 1'de ADR ile belgelenecektir.

### 5.2 Zarf formatı

```
Envelope (relay'in gördüğü):
  { v: 1, id, from, to, kind, ts_bucket, ciphertext }

ciphertext içi (yalnızca cihazlar görür):
  { type, taskId, counter, ts, nonce, body, sig }
  sig = Ed25519(sender_sign_priv, canonical(type, taskId, counter, ts, nonce, body, to))
```

- **Kanonik serileştirme:** İmzalanan veri, sıralı anahtarlarla ve deterministik biçimde JSON'a çevrilir (RFC 8785, JCS). Çapraz platform test vektörleri zorunludur.
- **Neden ayrı imza?** Noise kanalın gizliliğini ve bütünlüğünü sağlar. Ed25519 imzası ise mesajın **kimden** geldiğini kalıcı ve denetlenebilir olarak kanıtlar. İmza, denetim kaydında saklanır.

### 5.3 Tekrar oynatma (replay) koruması

- Her gönderen cihaz, her alıcı için monoton artan bir `counter` tutar. Ajan, son kabul ettiği sayacın altındaki mesajları reddeder.
- `ts` değeri ±5 dakikalık pencerenin dışındaysa mesaj reddedilir. Çevrimdışı kuyruktan gelen mesajlar için bu pencere görevin kendi süresiyle sınırlanır.
- Son 10.000 nonce saklanır; tekrar eden nonce reddedilir.

## 6. Komut Yetkilendirme

- Ajan yalnızca şu iki kaynaktan gelen komutları kabul eder:
  - **Eşleştirilmiş ve iptal edilmemiş bir telefonun imzaladığı** komutlar.
  - Masaüstü UI üzerinden, **yerel Windows kullanıcısının** verdiği komutlar.
- Relay kaynaklı mesajlar yalnızca kontrol mesajlarıdır: `ping`, `presence` ve `queue-drained`. Bu mesajlar hiçbir araç çalıştıramaz. Bu ayrım kod düzeyinde zorunlu tutulur: kontrol mesajı tipleri ayrı bir şemadadır ve orkestratöre bağlı değildir.
- **Telefon rolleri** (ajan tarafından, eşleştirmede belirlenir):
  - `owner`: Tüm komutlar ve tüm onaylar.
  - `operator`: Komut verebilir; onay yetkisi politikaya bağlıdır.
  - `viewer`: Yalnızca durum ve sonuç görüntüleyebilir.

## 7. Onay Sistemi

| Risk | Örnekler | Davranış |
|---|---|---|
| `read` | İzinli klasörü okumak, Excel analizi, ERP sorgusu (salt okunur) | Otomatik çalışır ve kaydedilir. |
| `write` | Çıktı klasörüne yeni rapor yazmak | Komutun kendi imzası yeterlidir. Kullanıcı ayarlardan "her seferinde sor" seçeneğini açabilir. |
| `critical` | Dosya silme veya üzerine yazma, program çalıştırma, e-posta gönderme, ERP'ye yazma, sipariş değiştirme, izin genişletme, dosyayı cihaz dışına aktarma (politika gerektiriyorsa) | **Her seferinde ayrı onay.** Varsayılan davranış reddetmektir. |

### 7.1 Onay akışı

1. Ajan, adımın insan tarafından okunabilir açıklamasını oluşturur. Ardından şu özeti hesaplar:

   ```
   digest = BLAKE2b(canonical({taskId, stepId, toolKey, params}))
   ```

2. Ajan, onay isteğini **kendi anahtarıyla imzalar** ve telefona gönderir. Bu sayede telefon, isteğin gerçekten ajandan geldiğini doğrular. Sahte bir onay ekranı gösterilemez.
3. Telefon kritik parametreleri açıkça gösterir: tam dosya yolları, alıcılar, tutarlar ve etkilenen kayıt sayısı.
4. Kullanıcı biyometrik doğrulamayı geçer. Bu adım Keystore anahtarının `setUserAuthenticationRequired` ayarıyla zorunlu tutulur.
5. Telefon şu yapıyı imzalar:

   ```
   {approvalId, taskId, stepId, digest, decision, issuedAt, expiresAt}
   ```

6. Ajan onayı çalıştırmadan önce şunları kontrol eder:
   - İmza, sabitlenmiş bir telefon anahtarına ait mi ve rolü yeterli mi?
   - Özet, adımın parametrelerinden yeniden hesaplanan özetle eşleşiyor mu?
   - Onay süresi dolmamış mı? (Varsayılan süre 10 dakikadır.)
   - Bu onay daha önce kullanılmamış mı?

   Bu kontrollerden herhangi biri başarısız olursa adım çalıştırılmaz.

### 7.2 Ek kurallar

- **Onay özeti:** Parametreler değişirse özet de değişir. Bu yüzden bir onay, başka bir işlem için kullanılamaz.
- **Toplu işlemler:** "50 dosya sil" gibi bir toplu işlem tek onayla yapılabilir. Ancak onay ekranında dosyaların tam listesi gösterilir ve özet bu listenin tamamını kapsar.
- **İkinci onay (opsiyonel):** Bir organizasyon politikası, belirli işlemler için iki farklı kişinin onayını (4-göz ilkesi) zorunlu kılabilir. Bu özellik Faz 4'e planlanmıştır.

## 8. Hesap Kimlik Doğrulaması (relay erişimi)

- **Parola saklama:** Argon2id (OWASP parametreleri).
- **MFA:** TOTP. Uzaktan erişimde tüm roller için zorunludur.
- **Token'lar:** Erişim token'ı 10 dakika geçerlidir. Refresh token tek kullanımlıktır; yeniden kullanılırsa token ailesi iptal edilir.
- **Kaba kuvvet koruması:** Başarısız denemelerde gecikme artar ve hesap kilitlenir.
- **Önemli:** Relay hesabı yalnızca relay'e bağlanmayı sağlar. Komut yetkisi, cihaz anahtarından gelir. Bu iki katman bilinçli olarak ayrılmıştır.

## 9. Dosya Erişimi

- **Varsayılan:** Hiçbir klasöre erişim yoktur. Klasörler yalnızca masaüstü UI'dan, yerel kullanıcı tarafından eklenir. Telefondan izin genişletme `critical` bir işlemdir.
- **Yol doğrulama:**
  - Tüm yollar `realpath` ile normalize edilir.
  - Şu hileler reddedilir: sembolik link ve junction ile allowlist dışına çıkma, `..`, UNC yolları, alternatif veri akışları (ADS) ve 8.3 kısa adlar.
- **Yasaklı klasörler:** `C:\Windows`, `Program Files`, `AppData`, tarayıcı profilleri, kimlik bilgisi depoları ve SSH/GPG klasörleri allowlist'e hiçbir zaman eklenemez.
- **Çıktı ve silme:**
  - Çıktılar varsayılan olarak ayrı bir `SAKLAZ Çıktılar` klasörüne yazılır.
  - Mevcut bir dosyanın üzerine yazmak `critical` sayılır.
  - Silme işlemi dosyayı kalıcı olarak silmez; Geri Dönüşüm Kutusu'na taşır.

## 10. Gizli Bilgilerin Saklanması

| Gizli bilgi | Saklama |
|---|---|
| Ajan anahtarları, ERP bağlantı bilgileri, (izinliyse) AI API anahtarları | DPAPI, kullanıcı kapsamında. Kullanıcı isterse ek entropi verilebilir. |
| Telefon anahtarları | Android Keystore. Mümkünse StrongBox. Dışarı aktarılamaz, kullanımı biyometrik doğrulamaya bağlıdır. |
| Relay sırları (JWT anahtarı, DB parolası) | Docker secrets veya dosya tabanlı sır deposu. Repoda tutulmaz. |
| MFA sırları | AES-256-GCM ile şifrelenir. Şifreleme anahtarı veritabanından ayrı tutulur. |

**Genel kurallar:**

- CI'da gitleaks zorunludur.
- Loglarda token, anahtar, parola ve kişisel veri maskelenir.
- Ajan logları içerik içermez; içerik yalnızca şifreli SQLite veritabanındadır.

## 11. AI ve Prompt Injection

- **Varsayılan:** Dış AI sağlayıcıları kapalıdır. `confidential` veri hiçbir zaman dış sağlayıcıya gönderilmez (K1).
- **Veri sınıfları:**
  - `public`
  - `internal`
  - `confidential`: ERP, AS9100, şirket dosyaları, müşteri verisi.
  - `secret`: Kimlik bilgileri. Hiçbir modele, yerel olsa bile, gönderilmez.
- **Güvenilmez içerik:** Model girdisinde güvenilmez içerik ayrı ve etiketli bloklarda verilir.
- **Model yetki sınırları:** Modelin çıktısı yalnızca bir **araç önerisidir**. Politika motoru öneriyi şemaya, izinlere ve risk seviyesine göre değerlendirir. Model şunları **yapamaz**:
  - Onayı atlamak.
  - Allowlist'i genişletmek.
  - Yeni bir alıcı veya yol uydurup onay ekranında gizlemek. Onay ekranı model metnini değil, adımın gerçek parametrelerini gösterir.
- **Test:** Bir prompt injection test seti, CI'da çalışan bir regresyon paketidir.

## 12. ERP Güvenliği

- **Erişim:** Connector kodunda yazma yolu yoktur. Sorgular önceden tanımlanmış ve parametrelidir; serbest SQL çalıştırılamaz. SELECT dışındaki her ifade reddedilir.
- **Salt okunur oturum:** Sorgular salt okunur işlem içinde çalışır (`SET TRANSACTION READ ONLY`). Bu, DB rolüne ek bir güvencedir.
- **Kaynak sınırları:** Sorgu zaman aşımı (`statement_timeout`) ve satır limiti uygulanır. Böylece ERP performansı korunur.
- **Kimlik bilgileri:** Connector, ASEDEN uygulamasının kendi DB kullanıcısını **asla** kullanmaz. Ayrı ve yalnızca okuma yetkili bir kimlik kullanır. Bu kimliğin oluşturulması, ASEDEN sahibinin kararı ve onayıyla olur (bkz. `docs/discovery/ASEDEN-KESIF.md`).
- **Firestore:** Firestore Admin SDK servis hesabı tam yazma yetkisi verir. Bu yüzden kullanılmaz.

## 13. Denetim Kaydı

| Konum | İçerik | Bütünlük |
|---|---|---|
| Ajan (asıl kayıt) | Her komut, imzası, plan, araç çağrısı, onay, ERP sorgusu, AI çağrısı (sağlayıcı, veri sınıfı, boyut) | Hash zinciri. Zincir başı periyodik olarak telefona imzalı gönderilir; böylece yerel silme tespit edilir. |
| Relay | Giriş, MFA, cihaz kaydı ve iptali, bağlantı, mesaj meta verisi | Hash zinciri. DB'de UPDATE ve DELETE yetkisi yoktur. |

**Saklama süresi:** Bir organizasyon ayarıdır. Varsayılan 2 yıldır ve AS9100 kayıt saklama gereksinimlerine göre uyarlanabilir.

## 14. Güvenli Geliştirme ve Dağıtım

- **Kod standartları:** TypeScript strict. Tüm sınırlarda zod ile doğrulama yapılır.
- **Kriptografi:** Kendi kripto primitiflerimizi yazmayız; yalnızca libsodium kullanılır.
- **Electron:**
  - `contextIsolation: true`
  - `nodeIntegration: false`
  - `sandbox: true`
  - Katı CSP. Uzak içerik yüklenmez.
- **CI:** gitleaks, CodeQL/Semgrep, `pnpm audit`, lisans kontrolü, kripto test vektörleri ve prompt injection paketi.
- **Dağıtım:**
  - Yükleyiciler kod imzalıdır.
  - Ajan güncellemeleri, sabitlenmiş yayın anahtarıyla doğrulanır.
  - Bağımlılıklar kilit dosyasıyla sabitlenir.
- **Harici denetim:** Faz 4 öncesinde harici bir penetrasyon testi ve kripto protokol incelemesi yapılması önerilir.

## 15. Kontrol Tablosu

| # | Kontrol | Faz | Durum |
|---|---|---|---|
| S1 | Argon2id + TOTP MFA + token rotasyonu | 1 | ⬜ |
| S2 | QR + SAS ile relay'den bağımsız eşleştirme; ortadaki adam (MITM) testi | 1 | ⬜ |
| S3 | Noise_KK E2EE; relay'in düz metin görmediğinin testi | 1 | ⬜ |
| S4 | Yalnız imzalı komut kabulü; relay kaynaklı komut reddi testi | 1 | ⬜ |
| S5 | Replay koruması (sayaç, zaman, nonce) | 1 | ⬜ |
| S6 | İmzalı onay + özet + süre + tek kullanım | 1 | ⬜ |
| S7 | Ajanın hiçbir port dinlememesi (port tarama testi) | 1 | ⬜ |
| S8 | Klasör allowlist ve yol hileleri test seti | 1 | ⬜ |
| S9 | DataGuard; `confidential` verinin dış sağlayıcıya gidememesi | 1 | ⬜ |
| S10 | Hash zincirli denetim kayıtları ve doğrulayıcı | 1 | ⬜ |
| S11 | Prompt injection regresyon paketi | 1 | ⬜ |
| S12 | Electron güvenlik ayarları testi | 1 | ⬜ |
| S13 | Çapraz platform kripto test vektörleri (TS ↔ Dart) | 1 | ⬜ |
| S14 | İmzalı güncelleme doğrulaması | 1 | ⬜ |
| S15 | ERP connector'da SELECT dışı ifade reddi ve salt okunur işlem | 2 | ⬜ |
| S16 | Ele geçirilmiş relay senaryosu entegrasyon testi | 1 | ⬜ |

## 16. Açık Bildirimi

Güvenlik açıkları herkese açık issue olarak değil, proje sahibine doğrudan ve gizli olarak bildirilir. İletişim kanalını proje sahibi belirleyecek.
