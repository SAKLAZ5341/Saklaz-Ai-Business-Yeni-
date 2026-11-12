# SAKLAZ AI — Yol Haritası

> Durum: **Taslak v0.1 — onay bekliyor.** Süreler tek tam zamanlı geliştirici varsayımıyla kaba tahmindir; Faz 0 sonunda güncellenecektir.

Durum işaretleri: ⬜ planlandı · 🟨 devam ediyor · ✅ tamamlandı **ve testleri geçiyor**. Testi olmayan veya çalışmayan hiçbir madde ✅ olarak işaretlenmez.

## Faz 0 — Keşif ve Temel (≈1–2 hafta)

Amaç: Varsayım yapmadan gerçek ortamı belgelemek ve iskeleti kurmak.

- ⬜ Windows ortam analizi: Windows sürümü, Office/Outlook türü (klasik / M365), yönetici yetkisi, antivirüs/EDR politikaları, ağ/proxy kısıtları.
- ⬜ ASEDEN ERP keşfi (**yalnızca dokümantasyon ve ERP yöneticisi ile görüşme; sisteme dokunmadan**): DB motoru ve sürümü, resmî API varlığı, ilgili tablolar/view'lar, salt okunur kullanıcı imkânı. Çıktı: `docs/discovery/aseden.md`.
- ⬜ Barındırma kararı (şirket içi / yurt içi bulut / yurt dışı bulut) — KVKK ve müşteri (ör. savunma sanayii) gereksinimleriyle birlikte.
- ⬜ AI veri politikası kararı: hangi veri sınıfı hangi sağlayıcıya gidebilir.
- ⬜ Monorepo iskeleti, ortak tsconfig/eslint, CI (lint + typecheck + test + gitleaks).
- ⬜ `packages/protocol` ilk şemaları.

**Çıkış kriteri:** Keşif raporları onaylandı, CI yeşil, açık sorular (ARCHITECTURE.md §9) yanıtlandı.

## Faz 1 — MVP (≈6–8 hafta)

Amaç: Telefondan güvenli şekilde komut gönderip Windows'ta dosya analizi ve rapor üretebilmek.

### MVP kapsamı (DAHİL)

**Merkez**
- ⬜ Kayıt/giriş, Argon2id, TOTP MFA, token rotasyonu
- ⬜ RBAC (owner, operator, viewer)
- ⬜ Cihaz eşleştirme (QR + doğrulama özeti) ve iptal
- ⬜ Görev kuyruğu (pg-boss) ve görev durum makinesi
- ⬜ WebSocket hub, cihaz çevrimiçi/çevrimdışı durumu
- ⬜ İmzalı onay akışı
- ⬜ FCM push (içeriksiz)
- ⬜ Hash zincirli audit log
- ⬜ Rapor/dosya paylaşımı (şifreli saklama)

**Windows Agent + Masaüstü**
- ⬜ Giden WSS bağlantısı, yeniden bağlanma, outbox
- ⬜ Politika motoru + klasör allowlist + risk seviyeleri
- ⬜ Araçlar: klasör listeleme/arama, Excel okuma ve analiz, PDF okuma, Word okuma, Excel/Word/PDF rapor oluşturma
- ⬜ Excel ve Raporlama ajanı
- ⬜ Kişisel Asistan ajanı (temel: dosya bulma, özetleme)
- ⬜ AI katmanı: `AIProvider` arayüzü + 1 bulut adaptörü + Ollama adaptörü + RuleEngine fallback + DataGuard
- ⬜ Masaüstü UI: Sohbet, Görevler, Onaylar, İşlem Geçmişi, Sistem Durumu, İzinler (koyu tema, lacivert/mavi)

**Android**
- ⬜ Giriş + MFA + biyometrik kilit
- ⬜ Yazılı komut gönderme
- ⬜ Görev geçmişi ve canlı görev durumu
- ⬜ Windows cihaz bağlantı durumu
- ⬜ Push bildirim
- ⬜ İşlem onaylama (biyometrik + imza)
- ⬜ Rapor görüntüleme/indirme (PDF, Excel önizleme)

### MVP dışında (BİLİNÇLİ OLARAK ERTELENDİ)

- ASEDEN ERP connector (keşif tamamlanmadan yazılmayacak) → Faz 2
- Sesli komut → Faz 2
- Outlook entegrasyonu, e-posta gönderme → Faz 3
- Tarayıcı otomasyonu, program açma, ekran yardımı → Faz 3
- Çoklu organizasyon, iOS, web paneli → Faz 4

**Çıkış kriteri:** Uçtan uca senaryo testleri geçer:
1. Telefondan "Raporlar klasöründeki Excel dosyalarını özetle" → masaüstünde rapor oluşur, telefonda görüntülenir.
2. Allowlist dışı klasöre erişim girişimi reddedilir ve loglanır.
3. Kritik işlem onaysız çalışmaz; süresi geçmiş veya değiştirilmiş onay reddedilir.
4. AI sağlayıcı kapalıyken kural tabanlı komutlar çalışır.
5. Güvenlik kontrolleri S1–S9, S11, S12 testleri yeşil.

## Faz 2 — ERP ve Uzman Ajanlar (≈6 hafta)

- ⬜ `erp-core` arayüzü + `MockErpConnector` (her kayıt `source: "mock"`)
- ⬜ ASEDEN salt okunur connector (keşif raporuna göre; ERP yöneticisinin oluşturduğu R/O kullanıcı ile)
- ⬜ Satınalma ajanı: açık talepler, bekleyen teklifler, geciken siparişler raporları
- ⬜ AS9100 Kalite ajanı: tedarikçi değerlendirme kayıtları, uygunsuzluk/DÖF takibi, denetim hazırlık kontrol listeleri
- ⬜ Yönetim Raporlama ajanı: haftalık/aylık özet panoları
- ⬜ Sesli komut (cihaz üzeri tanıma öncelikli)
- ⬜ Zamanlanmış görevler (ör. her pazartesi 08:00 satınalma özeti)

## Faz 3 — E-posta ve Bilgisayar Kontrolü (≈6 hafta)

- ⬜ Outlook okuma (Graph veya COM — Faz 0 kararına göre)
- ⬜ E-posta ajanı: özetleme, taslak hazırlama; gönderme = critical onay
- ⬜ Tarayıcı otomasyonu (Playwright, izole profil, site allowlist)
- ⬜ Uygulama allowlist'i ile program açma
- ⬜ Ekran yardımı (ekran görüntüsü yalnız kullanıcı isteğiyle, yerelde işlenir)
- ⬜ Windows Hizmeti olarak çalışma değerlendirmesi
- ⬜ OpenTelemetry gözlemlenebilirlik

## Faz 4 — Kontrollü Yazma ve Ölçek

- ⬜ ERP kontrollü yazma (`ErpWriteConnector`, ayrı kimlik bilgisi, her işlem onaylı)
- ⬜ Çoklu organizasyon, gelişmiş RBAC
- ⬜ Redis/BullMQ'ya geçiş (gerekirse)
- ⬜ Harici güvenlik testi (penetrasyon testi)
- ⬜ iOS ve web paneli değerlendirmesi

## Riskler

| Risk | Etki | Önlem |
|---|---|---|
| ASEDEN'e salt okunur erişim alınamaması | ERP ajanları gecikir | Faz 2'de dışa aktarılmış Excel raporları üzerinden çalışma alternatifi |
| Kurumsal antivirüs/EDR'nin ajanı engellemesi | Kurulum sorunları | Kod imzalama, IT ile beyaz liste süreci |
| AI sağlayıcıya veri gönderiminin müşteri sözleşmeleriyle çakışması | Özellik kısıtlanır | Yerel model + DataGuard varsayılanı |
| Kapsam genişlemesi | Gecikme | Her faz sonunda kapsam onayı |

## Sonraki Adım

Bu dokümanlar onaylandığında **Faz 0** başlatılacaktır. Faz 0 tamamlanmadan MVP kodlamasına geçilmeyecektir.
