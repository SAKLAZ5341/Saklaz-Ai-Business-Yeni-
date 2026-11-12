# ADR-0014: İmzalı cihaz listesi ve telefon–bilgisayar güven bağları

- **Durum:** Kabul edildi (proje sahibi, 2026-11-12). Sprint 2'de uygulanıyor.
- **Ayrıntı:** SECURITY.md §18

## Karar
- **Liste yapısı:** Liste yalnızca ekleme yapılabilen ve hash zinciriyle bağlı bir yapıdır. Girişleri yalnızca sahip telefonların onay anahtarı imzalayabilir.
- **İşlemler:**
  - `genesis`
  - `device.add`: eklenen cihazın eş-imzası zorunludur
  - `device.revoke`: cihaz kimliği ve tüm anahtarları kalıcı olarak yasaklanır
  - `link.set` ve `link.remove`
- **Yetkilendirme:** Telefonun bir bilgisayardaki rolü yalnızca o çifte ait bağdan okunur.
- **Güncellik:** Mesaj başlığındaki `rh` alanı, alıcının listesinin güncel olup olmadığını gösterir. Liste eskiyse mesaj işlenmez.
- **Çatallanma:** Tespit edilirse liste değişiklikleri durdurulur.

## Neden bağlar ayrı
Proje sahibi, cihazlar arası güven ilişkilerinin ayrı ayrı yönetilmesini istedi. Tek bir global rol yerine her telefon–bilgisayar çiftinin kendi rolü vardır. Böylece örneğin bir telefona ev bilgisayarında owner, iş bilgisayarında viewer rolü verilebilir.
