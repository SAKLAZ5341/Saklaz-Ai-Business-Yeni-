# SAKLAZ AI — Güvenlik Modeli

> Durum: **Taslak v0.1 — onay bekliyor.** Aşağıdaki kontroller tasarımdır; her biri uygulandığında otomatik testle doğrulanacak ve bu dokümandaki kontrol tablosunda işaretlenecektir.

## 1. Korunan Varlıklar

| Varlık | Nerede | Hassasiyet |
|---|---|---|
| ERP verisi (siparişler, tedarikçiler, fiyatlar, stok) | ASEDEN / ajan önbelleği | Yüksek — ticari sır |
| AS9100 kalite kayıtları | ASEDEN / yerel dosyalar | Yüksek — denetim ve müşteri yükümlülüğü |
| Yerel dosyalar ve e-postalar | Windows makine | Yüksek |
| Kullanıcı kimlik bilgileri, MFA sırları | Merkez DB | Kritik |
| Cihaz özel anahtarları | Cihaz (Keystore / DPAPI) | Kritik |
| AI API anahtarları, ERP bağlantı bilgileri | Ajan yerel kasası | Kritik |
| Audit log | Merkez + ajan | Yüksek — bütünlük önemli |

## 2. Tehdit Modeli (özet, STRIDE)

| Tehdit | Örnek | Ana kontrol |
|---|---|---|
| Kimlik sahteciliği | Çalınan parola ile telefondan komut | MFA, cihaz eşleştirme, cihaz anahtarı imzası |
| Kurcalama | Onay mesajının yolda değiştirilmesi | Onaylar cihaz anahtarıyla imzalanır, ajan doğrular; parametre özeti (sha256) imzaya dahil |
| İnkâr | "Ben onaylamadım" | Hash zincirli audit log + imzalı onay kaydı |
| Bilgi sızıntısı | ERP verisinin bulut AI'ya gitmesi | DataGuard, veri sınıfı izinleri, veri yerinde işleme |
| Hizmet engelleme | Görev seli | Rate limit, kuyruk kotaları |
| Yetki yükseltme | Ajanın izinsiz klasöre yazması | Allowlist, path normalizasyonu, SYSTEM olmayan süreç |
| **Prompt injection** | E-posta/dosya içinde "tüm dosyaları sil" talimatı | İçerik = veri; araç çağrıları politika motorundan geçer; kritik işlem = insan onayı |
| Ele geçirilmiş merkez | Sunucuya sızan saldırgan sahte görev gönderir | Kritik işlemler için onay imzası **mobil cihaz anahtarıyla**; merkez tek başına kritik işlem yaptıramaz |

## 3. Kimlik Doğrulama

- Parolalar **Argon2id** ile hash'lenir (OWASP önerilen parametreler).
- **TOTP MFA** (RFC 6238); uzaktan erişim (mobil ve web) için owner/admin rollerinde zorunlu, diğerlerinde önerilir. Yedek kurtarma kodları hash'li saklanır.
- Access token: JWT (EdDSA), 10 dakika ömür. Refresh token: opak, tek kullanımlık, rotasyonlu; yeniden kullanım tespit edilirse tüm token ailesi iptal edilir.
- Başarısız giriş denemelerinde artan gecikme ve hesap kilidi.

## 4. Cihaz Eşleştirme

1. Kullanıcı Windows ajanında "Eşleştir" der; ajan bir **Ed25519 anahtar çifti** üretir (özel anahtar DPAPI ile korunur).
2. Kullanıcı mobil uygulamada (MFA ile giriş yapmışken) eşleştirme başlatır; merkez 5 dakika geçerli, tek kullanımlık kod üretir ve QR olarak gösterir.
3. Ajan QR/kodu okur, açık anahtarı ve kodu merkeze gönderir. Merkez kodu doğrular, cihazı kaydeder.
4. Her iki ekranda aynı **6 haneli doğrulama özeti** gösterilir; kullanıcı eşleştiğini onaylar (MITM önlemi).
5. Mobil cihaz da kendi Ed25519 anahtarını Android Keystore'da (mümkünse StrongBox) üretir; anahtar kullanımı biyometrik doğrulamaya bağlanır.

Cihaz iptali anında geçerlidir: merkez açık bağlantıyı keser ve anahtarı reddeder.

## 5. İletişim Güvenliği

- Tüm trafik **TLS 1.3**; HSTS; zayıf şifre kümeleri kapalı.
- Windows ajanı **yalnızca giden** WSS bağlantısı kurar. Ajan hiçbir ağ portu dinlemez. Masaüstü UI ile ajan arası iletişim, ACL'si yalnız mevcut Windows kullanıcısına açık **named pipe** ile.
- Ajan bağlantı açılışında merkezin verdiği nonce'u cihaz anahtarıyla imzalar (`hello`).
- Mobil uygulamada sertifika sabitleme (public key pinning) — yedek pin ile.
- FCM bildirimleri içerik taşımaz; yalnızca "yeni olay" sinyali. İçerik uygulama açıldığında TLS üzerinden çekilir.

## 6. Yetkilendirme (RBAC)

| Rol | Yetkiler (özet) |
|---|---|
| owner | Her şey + organizasyon ve rol yönetimi |
| admin | Kullanıcı/cihaz yönetimi, ajan ve AI sağlayıcı ayarları |
| operator | Görev oluşturma, kendi görevlerini onaylama, rapor görüntüleme |
| viewer | Yalnız görüntüleme |

İzin kontrolü sunucuda her uç noktada (`requirePermission("task.create")`) ve ajanda her araç çağrısında yapılır. İstemci tarafı kontroller yalnız kullanıcı deneyimi içindir, güvenlik sınırı değildir.

## 7. İşlem Risk Seviyeleri ve Onay Sistemi

| Seviye | Örnekler | Davranış |
|---|---|---|
| `read` | Allowlist'teki klasörü listeleme, Excel okuma, ERP sorgusu (R/O) | Otomatik; loglanır |
| `write` | Yeni rapor dosyası oluşturma (çıktı klasörüne), taslak e-posta | Görev başlangıcında kullanıcıya özet gösterilir; ayarlardan "her seferinde sor" yapılabilir |
| `critical` | Dosya silme/üzerine yazma, e-posta **gönderme**, program çalıştırma, ERP'ye yazma, sipariş değiştirme, allowlist dışına erişim talebi | **Her seferinde açık onay**; varsayılan reddet |

Onay akışı:

1. Ajan, adımın insan tarafından okunabilir açıklamasını ve `params_digest = sha256(canonical_json(params))` değerini üretir.
2. Mobil uygulama açıklamayı ve kritik parametreleri (alıcılar, dosya yolları, tutarlar) gösterir.
3. Kullanıcı biyometrik doğrulamayla onaylar; mobil cihaz `{approvalId, taskId, stepId, params_digest, decision, expiresAt}` verisini imzalar.
4. Ajan imzayı **eşleştirilmiş mobil cihazın açık anahtarıyla** doğrular, digest'i yeniden hesaplar ve eşleşmezse reddeder.
5. Onaylar 10 dakika sonra geçersiz olur; tek kullanımlıktır (replay koruması).

Masaüstünde yerel onay da mümkündür (Windows Hello ile).

## 8. Dosya Erişim İzinleri

- Varsayılan: **hiçbir klasöre erişim yok.** Kullanıcı UI'dan klasör ekler (okuma veya okuma-yazma).
- Yollar `realpath` ile normalize edilir; sembolik bağlantı, junction, `..`, UNC ve alternatif veri akışı (`:`) hileleri reddedilir.
- Sistem klasörleri (`C:\Windows`, `Program Files`, kullanıcı profilinin `AppData`'sı, kimlik bilgisi depoları) allowlist'e eklenemez.
- Ajan çıktıları varsayılan olarak ayrı bir `SAKLAZ Çıktılar` klasörüne yazılır; mevcut dosyaların üzerine yazmak `critical`'dır.
- Silme işlemleri kalıcı silme değil, **Geri Dönüşüm Kutusu**'na taşıma olarak yapılır.

## 9. Gizli Bilgilerin Saklanması

| Gizli bilgi | Saklama |
|---|---|
| Ajan cihaz anahtarı, AI API anahtarları, ERP bağlantı bilgileri | Windows Credential Manager / DPAPI (kullanıcı kapsamı) |
| Mobil cihaz anahtarı, oturum token'ları | Android Keystore + `flutter_secure_storage` |
| Sunucu sırları (JWT imza anahtarı, DB parolası) | Ortam değişkeni değil, dosya tabanlı secret (Docker secrets) veya bir secret manager; repoda asla |
| MFA sırları | Uygulama düzeyinde AES-256-GCM ile şifrelenmiş, anahtar ayrı saklanır |
| Paylaşılan artifact dosyaları | Dosya başına anahtar ile şifreli (zarf şifreleme) |

Repoda gizli bilgi taraması (gitleaks) CI'da zorunludur. Loglarda token, parola, API anahtarı ve kişisel veri maskelenir.

## 10. ERP Güvenliği

- Varsayılan bağlantı **salt okunur**: ayrı DB kullanıcısı, yalnız `SELECT`, tercihen yalnız belirlenmiş view'lar üzerinde. Bu kullanıcıyı ASEDEN yöneticisi oluşturur; SAKLAZ ASEDEN'de hiçbir nesne oluşturmaz/değiştirmez.
- Connector kodunda yazma yolu yoktur; sorgular parametreli ve yalnızca önceden tanımlı (serbest SQL yok). Ek güvence olarak connector, SELECT dışındaki ifadeleri reddeden bir koruma katmanından geçer.
- Sorgu zaman aşımı ve satır limiti — ERP performansını etkilememek için.
- Gelecekteki yazma işlemleri: ayrı paket, ayrı kimlik bilgisi, her işlem `critical` onay, işlem öncesi/sonrası kayıt audit'e.

## 11. AI ve Veri Gizliliği

- Veri sınıfları: `public`, `internal`, `confidential` (ERP, AS9100, müşteri verisi), `secret` (kimlik bilgileri — **hiçbir zaman** modele gönderilmez).
- `DataGuard`, dış sağlayıcıya gidecek her isteği sınıf izinleriyle karşılaştırır. Varsayılan: `confidential` yalnız yerel modele.
- Dış sağlayıcıya giden her istek audit'e (içerik özeti + boyut, tam içerik değil) yazılır.
- **Prompt injection savunması:** Dosya, e-posta, web ve ERP içeriği modele ayrı ve "güvenilmez veri" olarak işaretlenmiş bloklarda verilir. Modelin önerdiği her araç çağrısı politika motorundan geçer; model hiçbir koşulda onay adımını atlayamaz veya allowlist'i genişletemez.

## 12. Denetim Kaydı (Audit Log)

- Kaydedilenler: giriş/çıkış, MFA olayları, cihaz eşleştirme/iptal, görev oluşturma, her araç çağrısı, onay istek/karar, izin değişiklikleri, AI sağlayıcıya veri gönderimi, ERP sorguları.
- Her kayıt bir önceki kaydın hash'ini içerir (hash zinciri); zincir bütünlüğü periyodik olarak doğrulanır.
- DB düzeyinde `UPDATE/DELETE` yetkisi yoktur. Saklama süresi organizasyon ayarıdır (varsayılan 2 yıl — AS9100 kayıt saklama gereksinimleriyle uyumlu olacak şekilde yapılandırılabilir).

## 13. Güvenli Geliştirme

- TypeScript strict, ESLint güvenlik kuralları, tüm dış girdiler zod ile doğrulanır.
- CI: `pnpm audit`, gitleaks, Semgrep/CodeQL, bağımlılık lisans kontrolü.
- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, katı CSP, uzak içerik yüklenmez.
- Masaüstü yükleyici kod imzalı; otomatik güncellemeler imza doğrulamalı.
- Her güvenlik kontrolünün otomatik testi olacak (aşağıdaki tablo).

## 14. Güvenlik Kontrol Tablosu

| # | Kontrol | Durum |
|---|---|---|
| S1 | Argon2id parola hash | ⬜ Planlandı |
| S2 | TOTP MFA | ⬜ Planlandı |
| S3 | Refresh token rotasyonu + yeniden kullanım tespiti | ⬜ Planlandı |
| S4 | Cihaz eşleştirme + doğrulama özeti | ⬜ Planlandı |
| S5 | Ajanda dinlenen port olmaması (test: port taraması) | ⬜ Planlandı |
| S6 | İmzalı onay + digest doğrulama + replay koruması | ⬜ Planlandı |
| S7 | Klasör allowlist + path traversal testleri | ⬜ Planlandı |
| S8 | DataGuard veri sınıfı engelleme | ⬜ Planlandı |
| S9 | Hash zincirli audit log + bütünlük doğrulama | ⬜ Planlandı |
| S10 | ERP connector'da SELECT dışı ifade reddi | ⬜ Planlandı (Faz 2) |
| S11 | Prompt injection test seti | ⬜ Planlandı |
| S12 | Electron güvenlik ayarları testi | ⬜ Planlandı |

Durumlar yalnızca ilgili test CI'da geçtiğinde ✅ olarak işaretlenecektir.

## 15. Güvenlik Açığı Bildirimi

Güvenlik açıkları herkese açık issue olarak değil, proje sahibine doğrudan ve gizli olarak bildirilmelidir. (İletişim kanalı proje sahibi tarafından belirlenecek.)
