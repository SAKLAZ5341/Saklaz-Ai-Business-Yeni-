# Sprint 3 — Aşama 1 Raporu: TOTP Tekrar Kullanım Koruması

> **Tarih:** 2026-11-13
> **Durum:** ✅ A1 tamamlandı ve **`main`'e ulaştı** (PR #7 → A0 dalı → PR #6 → `main` `13afcf1`). Ayrıntı: §8.
> **PR:** #7 (`s3/a1-totp-tekrar`; A1'in kendi commit'i `131d711`). Taban dal: `s3/a0-ci-yesil` (PR #6). Planlanan "tabanı `main` yapma" adımı uygulanmadı: PR #7 doğrudan A0 dalına birleştirildi (§8).
> **Yedek noktası:** `s3-a1-oncesi` etiketi (yerel).
> **Birleştirme:** Yapıldı (§8). *Rapor yazıldığı andaki durum:* `main` dal koruması henüz etkin değildi. K5 sonradan Ruleset `27197647` ile etkinleştirildi (Sprint 3 planı §9).

## 1. Sorun

`SECURITY.md` S1: relay girişinde TOTP kodu ±1 zaman adımı toleransla (≈ 90 sn) doğrulanıyordu, ama **kullanılmış kodlar kaydedilmiyordu.** Parolayı bilen ve bir kodu gören (omuz üstünden, ekran kaydından, kötü amaçlı bir proxy'den) biri aynı kodu 90 saniye içinde yeniden kullanabiliyordu.

## 2. Çözüm

| Bileşen | Değişiklik |
|---|---|
| Şema | `accounts.totp_last_step bigint` sütunu: hesapta başarılı girişte tüketilmiş **en yüksek** TOTP adımı. Negatif olamaz (CHECK). Migration `002_totp_replay.sql` idempotent. |
| Atomik tüketme | Kodun eşleştiği adım tek bir koşullu `UPDATE ... WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $adım)` ile tüketilir. Satır güncellenmezse kod reddedilir. PostgreSQL satır kilidi, aynı kodla gelen eşzamanlı isteklerin sırayla değerlendirilmesini sağlar: **en fazla biri** başarılı olur. |
| Eski adımlar | Yalnızca aynı kod değil, tüketilmiş adımdan **eski** her adımın kodu da (pencere içinde olsa bile) reddedilir. Bu, RFC 6238 §5.2'deki öneriden daha katıdır. |
| Kalıcılık | Durum yalnızca veritabanındadır, süreç belleğinde değildir. Sunucu yeniden başlatıldığında, birden fazla relay süreci aynı veritabanını kullandığında veya yük dengeleme yapıldığında koruma sürer. |
| Hata yanıtı | Tekrar kullanım istemciye yanlış koddan **ayırt edilemez**: ikisi de `401 INVALID_CREDENTIALS`. Böylece saldırgan, kodun doğru olduğunu ama başkası tarafından kullanıldığını öğrenemez. |
| Denetim | Tekrar kullanım `audit_meta` zincirine `login.totp_replay` olarak yazılır. Meşru kullanıcının kodu ondan önce başkası tarafından kullanıldıysa iz kalır. |
| Kilitlenme | Tekrar kullanım başarısız deneme sayılır ve kilitlenme sayacına eklenir. Sayaç artık **atomik** artırılır; önceki kodda eşzamanlı başarısız denemeler birbirinin üzerine yazılıp kaybolabiliyordu. |
| Şema çalıştırma | `migrate()` şema dosyalarını sırayla, bir PostgreSQL danışma kilidi altında çalıştırır. Aynı veritabanına bağlı iki relay süreci aynı anda başlarsa yarış olmaz. |

### Değişen dosyalar

| Dosya | Değişiklik |
|---|---|
| `apps/relay/migrations/002_totp_replay.sql` | **Yeni** |
| `apps/relay/src/totp.ts` | `matchTotpStep()` (eşleşen adımı döndürür; birden fazla eşleşmede en yükseği), `totpStep()`. `verifyTotp()` korundu. |
| `apps/relay/src/accounts.ts` | Atomik tüketme, atomik başarısız deneme sayacı, `login.totp_replay` denetimi, `totpLastStep()` |
| `apps/relay/src/db.ts` | Sıralı ve kilitli `migrate()` |
| `apps/relay/src/index.ts` | Yeni dışa aktarımlar |
| `apps/relay/test/totp-replay.test.ts` | **Yeni:** 13 test |

**Dokunulmayanlar:** `packages/crypto`, `packages/protocol`, `apps/agent`, `apps/mobile`. Doğrulandı: `git diff` bu klasörlerde boş.

## 3. Test sonuçları

### 3.1 Yeni testler (13)

| # | Test | Ortam |
|---|---|---|
| 1–2 | `matchTotpStep`: −1/0/+1 eşleşir; ±2 adım ve hatalı biçimler (5 hane, 7 hane, harf, boş) eşleşmez | Birim |
| 3 | Aynı kod aynı adımda ikinci kez reddedilir; `login.totp_replay` denetim kaydında | Gerçek PostgreSQL |
| 4 | +1 adım kullanıldıktan sonra 0 ve −1 adımların kodları reddedilir; zaman ilerleyince yeni kod kabul edilir | Gerçek PostgreSQL |
| 5 | **Süre aşımı:** ±2 adım red, −1 adım ilk kullanımda kabul; hiç kullanılmamış kod 90 sn sonra geçersiz | Gerçek PostgreSQL |
| 6 | **Eşzamanlılık:** aynı kodla 12 eşzamanlı istek → tam 1 başarılı, 11 red; denetimde 1 `login.ok`, 11 `login.totp_replay` | Gerçek PostgreSQL |
| 7 | Eşzamanlı 7 başarısız deneme sayaçta kaybolmaz | Gerçek PostgreSQL |
| 8 | **Yeniden başlatma:** havuz kapatılır, yeni havuz + yeni `Accounts` + şema yeniden çalıştırılır → kod hâlâ reddedilir | Gerçek PostgreSQL |
| 9 | **Gerçek HTTP:** 5 eşzamanlı istek → 1 × 200, 4 × 401; tekrar yanıtı yanlış kod yanıtıyla birebir aynı | Gerçek relay + PostgreSQL |
| 10 | **Farklı çalışma alanları:** iki ayrı relay veritabanı (PERSONAL ve BUSINESS), aynı e-posta. Sırlar farklı; birinde tüketilen adım diğerini etkilemez; ikisinde de tekrar reddedilir. | İki ayrı PostgreSQL veritabanı |
| 11 | Aynı relay'deki iki hesap bağımsız | Gerçek PostgreSQL |
| 12 | 3 tekrar denemesi hesabı kilitler; sonraki adımın geçerli kodu bile kabul edilmez (423) | Gerçek PostgreSQL |
| 13 | Şema dosyaları art arda ve eşzamanlı (3 paralel) çalıştırılınca hata yok | Gerçek PostgreSQL |

**Negatif kontrol:** Giriş kodu geçici olarak eski haline döndürüldüğünde 13 testin **9'u kırmızı** oldu. Kalan 4 test (iki birim testi, süre aşımı ve şema idempotansı) eski kodun zaten doğru yaptığı davranışları da doğruluyor. Yeni kod geri konunca 13/13 yeşil.

### 3.2 Toplam

| Ortam | Sonuç |
|---|---|
| Yerel (Linux + PostgreSQL 16) | ✅ crypto 34, protocol 88, agent 26, relay 34 = **182** (önce 169). Kapsama eşikleri tutuyor. |
| GitHub CI — PR #7, ubuntu + PostgreSQL | ✅ crypto 34, protocol 88, agent 26, relay 34 (`totp-replay.test.ts` 13/13) |
| GitHub CI — Windows | ✅ crypto 34, protocol 88, agent 26 |
| GitHub CI — Dart | ✅ 7/7 |
| GitHub CI — Pester, gitleaks, CodeQL | ✅ 8/8, sızıntı yok, ✅ |

Sprint 1–2 ve A0 testlerinin hiçbiri silinmedi, gevşetilmedi veya değiştirilmedi.

## 4. Güvenlik değerlendirmesi

| Tehdit | A1 öncesi | A1 sonrası |
|---|---|---|
| Gözlemlenen kodun ≈ 90 sn içinde yeniden kullanımı | Mümkündü | Engellendi: kod tek kullanımlık, eski adımlar da geçersiz |
| Aynı kodla yarış (eşzamanlı istekler) | Hepsi başarılı olurdu | En fazla biri başarılı |
| Sunucuyu yeniden başlatarak korumayı sıfırlama | — | Etkisiz: durum veritabanında |
| Tekrar denemesinin "kod doğruydu" bilgisini sızdırması | — | Sızdırmaz: yanıt yanlış kodla aynı |
| Eşzamanlı denemelerle kilitlenme sayacını atlatma | Sayaç kaybolabiliyordu | Sayaç atomik |

**Model içindeki yeri:** TOTP yalnızca **relay'e bağlanma** yetkisini korur. Ajana komut vermek, telefonun cihaz anahtarıyla imzalı mesaj gerektirir (S4). Bu yüzden relay girişinin tamamen atlatılması bile tek başına bilgisayarda komut çalıştırmaz. A1 bu katmanı güçlendirir, güven modelini değiştirmez.

## 5. Kalan riskler

| # | Risk | Açıklama | Önlem / durum |
|---|---|---|---|
| R-A1-1 | TOTP sırrının çalınması | Relay veritabanı **ve** ayrı dosyadaki MFA anahtarı birlikte ele geçirilirse saldırgan yeni kodlar üretebilir. Tekrar koruması bunu engellemez. | Sır AES-256-GCM ile şifreli; anahtar veritabanı dışında. Sunucu sıkılaştırma S5'te. |
| R-A1-2 | Gerçek zamanlı oltalama (AitM) | Saldırgan kullanıcıdan taze kodu alıp **önce** kendisi kullanırsa giriş yapar. TOTP'nin doğal sınırıdır. | Meşru kullanıcının girişi reddedilir ve `login.totp_replay` iz bırakır. Kalıcı çözüm, oltalamaya dayanıklı kimlik doğrulamadır (cihaz anahtarı / passkey); Faz 1 kapsamında değil. Relay girişi komut yetkisi vermediği için etki sınırlı. |
| R-A1-3 | Sunucu saatinin geri gitmesi | `totp_last_step` gerçek zamandan ilerideyse geçerli kodlar, saat o noktaya gelene kadar reddedilir. Bu bir **erişilebilirlik** riskidir, güvenlik riski değil. | Sunucuda NTP zorunlu (S5 kurulum belgesine eklenecek). |
| R-A1-4 | Relay veritabanının eski yedekten geri yüklenmesi | `totp_last_step` geri gider; o anda geçerli pencere içindeki kod yeniden kullanılabilir. | Pencere ≤ 90 sn; pratikte ihmal edilebilir. Belgelenir. |
| R-A1-5 | Kilitlenmenin hizmet engelleme amacıyla kullanılması | E-postayı bilen biri hatalı denemelerle hesabı 15 dk kilitleyebilir. A1'den önce de vardı. | IP başına hız sınırı mevcut. Ayrıntılı değerlendirme S5'te. |
| R-A1-6 | Kilit sırasında yarış | Hesap kilitlenirken eşzamanlı gelen **doğru** bir giriş kilidi kaldırabilir (başarılı giriş sayacı sıfırlar). A1'den önce de vardı; A1 kapsamında değiştirilmedi. | S5'te başarılı giriş güncellemesine kilit koşulu eklenmesi değerlendirilecek. |
| R-A1-7 | Kullanılabilirlik | Aynı hesapla 30 sn içinde iki cihazdan (ör. telefon ve masaüstü) giriş yapan kullanıcı, ikinci cihazda **bir sonraki kodu** beklemek zorundadır (en fazla 30 sn). RFC 6238'in önerdiği standart davranış budur. | S4'teki uygulama ekranında "bu kod kullanıldı, yeni kodu bekleyin" yerine genel bir mesaj gösterilecek (bilgi sızdırmamak için). |

## 6. Gerçek cihaz doğrulaması

| Platform | Durum |
|---|---|
| **Windows** | A1 yalnızca relay sunucusunu değiştirir; Windows ajanında değişiklik yok. Relay testleri Windows'ta çalışmaz (relay Linux'ta çalışır). **Gerçek Windows'ta doğrulanacak bir A1 maddesi yok.** |
| **Android** | Android uygulaması henüz yok (S4). RFC 6238 resmî test vektörleri geçiyor, ama **gerçek bir kimlik doğrulayıcı uygulamasıyla (Google Authenticator, Microsoft Authenticator vb.) uyumluluk henüz denenmedi.** `otpauth://` adresiyle QR kurulumu ve kod kabulü S4'te gerçek telefonla test edilecek. |
| **Gerçek relay sunucusu** | Testler gerçek PostgreSQL 16 ile yerelde ve GitHub CI'da çalıştı. **Gerçek bir sunucuda (VPS / şirket DMZ) çalıştırılmadı** (S5). Docker imajı A2'de doğrulanacak. |

## 7. Sonraki adım

*Rapor yazıldığı andaki bekleyen işler; hepsi sonradan tamamlandı:*

1. ~~GitHub'da `main` dal korumasının (K5) açılması~~ → Ruleset `27197647` etkin.
2. ~~PR #6 ve PR #7 birleştirme onayı~~ → birleştirildi (§8).
3. ~~A2 için onay~~ → A2 tamamlandı (SPRINT-3-A2-RAPOR.md).

## 8. Birleştirme kaydı (GitHub API'den doğrulandı, 2026-11-13)

| | Değer |
|---|---|
| PR | #7, `s3/a1-totp-tekrar` → `s3/a0-ci-yesil` |
| Birleştiren | SAKLAZ5341 (proje sahibi), GitHub arayüzünden |
| Zaman | 2026-11-13 09:32:50 (İstanbul) |
| Yöntem | Merge commit (ebeveynler: `3175947`, `2fb6748`) |
| Birleştirme commit'i | `4d79c86` |
| PR'ın son baş commit'i | `2fb6748`. Bu, A2'nin (PR #8) A1 dalına birleştirilmesiyle oluşmuştu; PR #7 bu yüzden A1 **ve** A2'yi birlikte taşıdı. |
| Dosya ağacı | `4d79c86` = A2'nin son commit'i `c36043f` (birebir aynı) |
| `main`'e ulaşma | PR #6 ile, `13afcf1` (2026-11-13 10:56) |
| PR #7 başında CI (`2fb6748`) | 8/8 yeşil (Docker dahil) |

Bu rapordaki TOTP tekrar kullanım koruması (A1) `main`'de çalışıyor. `main` üzerindeki birleştirme sonrası CI'da relay testleri 57/57 (A1'in 13 testi dahil) ve Docker testleri 13/13 yeşil; Docker testleri TOTP tekrar ve eşzamanlılık senaryolarını konteynerde de doğruluyor.

