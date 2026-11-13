# SAKLAZ AI 0.1.0-alpha — Sürüm notları

**Durum:** test sürümü (alfa). Gerçek cihaz doğrulaması bekleniyor; bkz. [BILINEN-EKSIKLER.md](BILINEN-EKSIKLER.md).
**Dal / PR:** `feat/mvp-alpha` / #13. PR #12'nin (A3 DPAPI) üzerine kuruludur.

## Yeni

### Android uygulaması
- **Karanlık arayüz:** Cihazlar, Komut, AI, Not/Görev ve Ayarlar ekranları.
- **Kişisel ve kurumsal çalışma alanları:** Her alanın ayrı relay'i, ayrı hesabı, ayrı telefon kimliği ve anahtarları ve ayrı yerel verisi vardır (not, görev, sohbet, AI ayarı). Aynı anda yalnızca etkin alanın bağlantısı açıktır.
- **Hesap:** oluşturma ve giriş (parola + TOTP). Yenileme token'ı yalnızca güvenli depoda tutulur.
- **Bilgisayar eşleştirme:** QR (kamera veya yapıştırma) ve iki ekranda karşılaştırılan 6 haneli güvenlik kodu (SAS).
- **Birden çok bilgisayar:** Her birinin ayrı kimliği ve anahtarları vardır. Çevrimiçi/çevrimdışı durumu ve son görülme zamanı görünür.
- **Komut gönderme ve sonuç:** Sonuçlar "alındı → çalışıyor → tamamlandı/başarısız" adımlarıyla izlenir.
- **Yapay zekâ:**
  - OpenAI (Responses API) veya yerel OpenAI uyumlu sunucu (Ollama vb.).
  - Dört kip: kişisel asistan, günlük plan, toplantı, satınalma.
  - Kurumsal alanda bulut AI varsayılan olarak kapalıdır.
  - Anahtar yoksa sahte yanıt üretilmez.
  - AI komut gönderemez.
- **Not ve görev:** alana özel, şifreli yerel depoda.
- **Güvenlik:** acil kilit gönderme, bilgisayarı kalıcı olarak çıkarma (imzalı iptal; diğer bilgisayarlara da iletilir).
- **Kabuk:** Flutter. Android Keystore destekli depo, yerel HTTP ve QR okuma sağlar. WebView yalnızca paketteki arayüzü açar.

### Windows ajanı
- **Komutlar:** `setup` (relay, bilgisayar adı, hesap girişi), `pair` (QR + SAS), `run`, `status`, `lockdown`, `selftest`, `version`.
- **Anahtar koruması:** DPAPI (kullanıcı kapsamı) ile korunan KEK. Kasa `vault.bin` dosyasında AES-256-GCM ile şifreli; veritabanı SQLCipher.
- **Profil izolasyonu:** `personal` ve `business` profilleri `%LOCALAPPDATA%\SAKLAZ\agent-<profil>` altında. Ayrı kasa, ayrı kimlik, ayrı relay.
- **İzinli komutlar** (yalnızca salt okunur): sistem, disk, ağ, işlemler, çalışma süresi, ping, yardım. Diğer her metin `NOT_ALLOWED` ile reddedilir. Kabuk, dosya yazma veya program başlatma yoktur.
- **Kimlik ve yetki denetimi:** Telefonun cihaz anahtarıyla imza, cihaz listesindeki rol, tekrar oynatma penceresi, zaman denetimi ve acil kilit. Bu denetimler Sprint 1–3 çekirdeğinden gelir.
- **Bağlantı kopması:** Üstel geri çekilmeyle yeniden bağlanır. Relay kuyruğundaki komutlar bağlanınca işlenir.
- **Günlük:** 5 MB sınırlı, JSON. Parola, token, komut metni veya komut çıktısı yazılmaz.
- **Başlangıç görevi:** Windows oturum açılışında başlar, yönetici yetkisi gerekmez. Taşınabilir zip paketin içinde Node.js çalışma zamanı ve yerel modüller vardır.

### Ortak çekirdek ve altyapı
- `@saklaz/client-core`:
  - telefon istemcisi
  - WebSocket relay bağlantısı
  - hesap API'si ve dönen yenileme token'ı
  - yeni eşleştirilen bilgisayarın listeyi diğer bilgisayarlara yayması ve `roster.need` yanıtı
- Ajan çekirdeğine `onCommand` kancası eklendi. Komut, ack gönderildikten sonra çalışır (Noise taşımasının sıralı olması gerekir).
- **CI'da yeni işler** (çıktılar artifact olarak indirilir):
  - **Windows ajan paketi (MVP alfa):** gerçek DPAPI ile öz-sınama ve başlangıç görevini kurma/kaldırma
  - **Android APK (MVP alfa):** Flutter 3.27.4; `flutter analyze` temiz
- Yerel ağ test kipi için relay Compose eki: `infra/relay/docker-compose.lan-test.yml`.

## Değişmeyenler
- `@saklaz/crypto` ve `@saklaz/protocol` paketlerinde değişiklik yok. Yeni kriptografik yapı eklenmedi.
- Ruleset ve branch koruması değişmedi.
- Sunucuya kurulum veya deployment yapılmadı.

## Yükseltme notu
İlk sürüm. Önceki bir kurulumdan veri taşınmaz.
