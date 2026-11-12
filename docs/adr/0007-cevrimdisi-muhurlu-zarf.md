# ADR-0007: Çevrimdışı alıcıya mühürlü zarf ve sınırlı ileri gizlilik

- **Durum:** Önerildi (Sprint 1). Proje sahibinin onayını bekliyor.
- **Tarih:** 2026-11-12

## Bağlam
Noise_KK oturumu iki tarafın aynı anda çevrimiçi olmasını gerektirir. Ancak telefon, kapalı bir bilgisayara
komut gönderebilmeli ("açılınca çalıştır") ve acil kilit/cihaz iptali mesajları kuyrukta bekleyebilmelidir.

## Karar
Alıcı çevrimdışıyken mesaj **mühürlü zarf** ile gönderilir (`packages/crypto/src/sealed.ts`):
`ikm = DH(geçici, alıcı) || DH(gönderen_statik, alıcı)`, `k = HKDF-BLAKE2b(ikm, eph||S||R, "SAKLAZ-v1/sealed")`,
XChaCha20-Poly1305. İçerik ayrıca Ed25519 ile imzalıdır ve tüm doğrulama hattından (imza, sayaç, imzalı ömür) geçer.

## Sonuçlar
- Gönderenin statik DH bileşeni sayesinde alıcı, zarfın eşleştirilmiş cihazdan geldiğini anahtar düzeyinde de doğrular (testli).
- **Kabul edilen sınır:** Alıcının statik DH anahtarı ileride ele geçirilirse, o anahtara mühürlenmiş geçmiş kuyruk mesajları çözülebilir. Canlı trafik ileri gizlilikli Noise_KK kullanır. Kuyruk mesajlarının ömrü imzalı olarak en çok 72 saattir ve relay teslimden sonra siler.
- Gelecekte iyileştirme seçeneği: alıcının önceden yayınladığı, imzalı tek kullanımlık ön anahtarlar (X3DH benzeri). Faz 4'te değerlendirilecek.
