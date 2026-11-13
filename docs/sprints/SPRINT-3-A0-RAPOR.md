# Sprint 3 — Aşama 0 Raporu: CI'ı Yeşile Çekmek

> **Tarih:** 2026-11-13
> **Durum:** ✅ A0 tamamlandı. PR #6 (`s3/a0-ci-yesil`, commit `3175947`) GitHub CI'da bütün işlerde yeşil. **Birleştirme ve A1 için proje sahibinin onayı bekleniyor.**
> **Yedek noktası:** `s3-a0-oncesi` etiketi (yerel) ve `yedek/sprint2-son` dalı (GitHub).

## 1. Bulgular ve kök nedenler

### B1 — Windows'ta 14 ajan testi `EBUSY: resource busy or locked`

Linux'ta `/proc/self/fd` ile açık tanıtıcılar sayılarak iki ayrı kök neden doğrulandı.

| # | Kök neden | Tür | Kanıt |
|---|---|---|---|
| B1-a | `openAgentDb`, yanlış anahtarla (SQLITE_NOTADB) veya bozuk dosyayla açılışta `Database` tanıtıcısını **kapatmadan** hata fırlatıyordu. `AgentCore` kurucusu da veritabanı açıldıktan sonraki bir hatada (ör. kasa okunamazsa) tanıtıcıyı açık bırakıyordu. | **Üretim kodu hatası** | Başarısız açılış denemesinden sonra 1 sızan tanıtıcı |
| B1-b | Testlerin çoğu ajanı hiç kapatmıyordu. Linux açık dosyanın silinmesine izin verdiği için görünmüyordu. | Test hatası | Her açık ajan için 3 tanıtıcı (veritabanı, WAL, SHM) |

### B2 — Dart onay özeti uyuşmazlığı

v0.3'te onay özetine ve telefonun imzaladığı baytlara eklenen `ws` (çalışma alanı) alanı, Sprint 1'de yazılıp hiç çalıştırılmamış Dart testinde eksikti. **Kripto veya JCS uyuşmazlığı değil.** Ed25519, BLAKE2b, X25519, imzalı komut ve JCS testleri ilk çalışmada da birebir uyumluydu.

## 2. Değişen dosyalar

| Dosya | Değişiklik |
|---|---|
| `apps/agent/src/db.ts` | Açılış hatasında tanıtıcı kapatılır, hata yeniden fırlatılır. |
| `apps/agent/src/core.ts` | Kurucu, veritabanı açıldıktan sonraki her hatada tanıtıcıyı kapatır. `close()` iki kez çağrılabilir. Kurucunun gövdesi yalnızca `try` bloğuna alındı; mantık değişmedi. |
| `apps/agent/test/agent.test.ts` | `afterEach` önce bütün ajanları kapatır. Platforma göre tanıtıcı denetimi (`fileIsReleased`) ve 3 yeni regresyon testi. |
| `packages/protocol/src/approval.ts` | Özet girdisi `approvalDigestInput` adıyla ayrı fonksiyona çıkarıldı. `computeApprovalDigest` bunu kullanır; **davranış aynı.** |
| `packages/protocol/src/index.ts` | `approvalDigestInput` dışa aktarıldı. |
| `packages/protocol/scripts/generate-vectors.ts`, `test-vectors/saklaz-v1.json` | Vektöre `digestInputHex` eklendi (1 satır). **Mevcut özet, imza ve diğer bütün değerler değişmedi.** |
| `apps/mobile/vector_check/test/vectors_test.dart` | `ws` alanı eklendi. Önce özet girdisi karşılaştırılır; bir sapmada hangi alanın farklı olduğu görülür. |

**Dokunulmayanlar:** `packages/crypto` (kripto çekirdeği), Noise durum makinesi, imza alanları, doğrulama hattı sırası, roster, rollback ve kilit mantığı, relay.

## 3. Test sonuçları

### 3.1 GitHub CI — PR #6, commit `3175947`

| İş | Sonuç |
|---|---|
| TypeScript — ubuntu + PostgreSQL 16 | ✅ crypto 34, protocol 88, agent 26, relay 21 = **169** |
| **Windows** — kripto, protokol, ajan (gerçek SQLCipher yerel modülü) | ✅ crypto 34, protocol 88, **agent 26** (önce 3/17 geçiyordu) |
| **Dart** uyumluluk vektörleri (S13) | ✅ **7/7** (önce 6/7) |
| Windows envanter betiği (Pester) | ✅ 8 geçti, 0 atlandı |
| gitleaks | ✅ sızıntı yok |
| CodeQL | ✅ |

Relay testleri yalnızca Linux'ta çalışır; relay Windows'ta çalıştırılmayacak.

### 3.2 Yeni regresyon testleri

| Test | Ne doğrular |
|---|---|
| Yanlış anahtarla açma denemesi dosya tanıtıcısı bırakmaz | B1-a (`openAgentDb`) |
| Ajan kurulumu, veritabanı açıldıktan sonra hata verirse dosya tanıtıcısı bırakılmaz | B1-a (`AgentCore` kurucusu) |
| Ajan kapatıldıktan sonra veritabanı dosyası serbesttir; `close()` iki kez çağrılabilir | B1-b ve idempotent kapatma |

**Negatif kontrol:** `db.ts` düzeltmesi geçici olarak geri alındığında ilk test kırmızı oldu (1 kaldı, 18 geçti). Düzeltme geri konunca yeşil oldu. Yani testler gerçekten koruma sağlıyor.

Tanıtıcı denetimi Linux'ta `/proc/self/fd` ile, Windows'ta açık dosyanın yeniden adlandırılamamasıyla yapılır. İkisi de CI'da çalıştı.

### 3.3 Korunan testler

Sprint 1–2'nin hiçbir testi silinmedi veya zayıflatılmadı. Kapsama eşikleri değişmedi. Test sayısı 166'dan 169'a çıktı.

## 4. Güvenlik etkileri

| Konu | Değerlendirme |
|---|---|
| Kaynak sızıntısı (B1-a) | Önceden, kasa anahtarı eksik veya yanlışsa her başarısız açılış bir tanıtıcı sızdırıyordu. Windows'ta bu, veritabanı dosyasının süreç kapanana kadar **kilitli kalması** demekti. Kilitli dosya yedekleme, geri yükleme ve kurtarma akışlarını engelleyebilirdi. Gizlilik ihlali değil, kullanılabilirlik ve sağlamlık sorunuydu. Düzeltildi. |
| Hata davranışı | Yanlış anahtarla açılış **hâlâ reddediliyor** (mevcut test korunuyor). Değişiklik yalnızca reddedişten sonra kaynakların temizlenmesidir. |
| S20 (rollback) | Windows'ta ilk kez gerçek SQLCipher dosyasıyla geçti: veritabanı dosyasının geri yüklenmesi tespit ediliyor. DPAPI kasası henüz yok (A3); kasa hâlâ bellek içi test kasası. **S20 🟨 olarak kalır.** |
| S13 (çapraz platform) | Dart tarafı bütün vektörlerde ilk kez yeşil. Ancak bu, gerçek bir Android cihazda değil, GitHub'ın Linux sanal makinesinde Dart VM ile doğrulandı. **S13 🟨 olarak kalır.** |
| Protokol | Kablo biçimi, özet ve imza baytları değişmedi. Vektördeki mevcut değerlerin aynı kalması bunu kanıtlar. |
| Telefon uygulaması için ders | Dart'taki hata, özet alanlarının elle yeniden yazılmasından doğdu. Android uygulamasında (S4) aynı risk var. Artık vektör özet girdisinin baytlarını da içeriyor ve Dart testi önce bunları karşılaştırıyor. |

## 5. Gerçek cihazda doğrulanmamış konular

- Windows sonuçları GitHub'ın **Windows Server 2022 sanal makinesinde** alındı. Hedef şirket bilgisayarında (Windows 10/11, alan üyeliği, EDR) çalıştırılmadı.
- Dart sonucu **Android cihazda değil**, Linux üzerindeki Dart VM'de alındı.

## 6. Yapılamayanlar ve sizden beklenenler

| Madde | Durum |
|---|---|
| **K5 — `main` dal koruması** | Bu oturumun GitHub erişimi dal koruması ayarını değiştirmeye izin vermiyor (HTTP 403). **Sizin açmanız gerekiyor:** GitHub → repo → Settings → Branches → "Add branch protection rule" (veya Rules → Rulesets). Dal: `main`. "Require status checks to pass" açık ve "Require branches to be up to date" işaretli. Zorunlu kontroller: `TypeScript (lint, sınır, tip, test) — ubuntu + PostgreSQL`, `Windows — kripto, protokol ve ajan (SQLCipher yerel modülü)`, `Dart uyumluluk vektörleri (S13)`, `Windows envanter betiği (Pester, D6)`, `Gizli bilgi taraması (gitleaks)`. "Do not allow bypassing the above settings" işaretli. "Allow force pushes" ve "Allow deletions" **kapalı**. |
| Etiketin GitHub'a gönderilmesi | Engelli; yedek noktaları dal olarak tutuluyor. |
| PR #6'nın birleştirilmesi | Onayınızı bekliyor. Birleştirmeyi siz GitHub'dan yapabilir ya da bana bırakabilirsiniz. |
