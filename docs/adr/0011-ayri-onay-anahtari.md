# ADR-0011: Telefonda komut anahtarı ile onay anahtarının ayrılması

- **Durum:** Önerildi (Sprint 1). Protokolde uygulandı.
- **Tarih:** 2026-11-12

## Bağlam
Proje sahibi, onayın genel bir "evet" olmamasını, işlemin kendisini kapsamasını ve sonradan değiştirilememesini istedi.
Her komut da telefonda imzalanıyor. Tek anahtar kullanılırsa iki kötü seçenek kalır:
- Her komutta biyometrik doğrulama istenir; bu kullanışsızdır.
- Ya da anahtar bir süre kilitsiz kalır; bu durumda o süre içinde onay da atılabilir.

## Karar
Telefon, eşleştirmede **iki Ed25519 anahtarı** kaydeder:

| Anahtar | Biyometrik doğrulama | Kullanımı |
|---|---|---|
| **Komut anahtarı** | Kısa bir süre geçerli | `cmd.*`, `history.query` vb. mesaj imzaları |
| **Onay anahtarı** | **Her kullanımda** zorunlu; StrongBox tercih edilir | Yalnızca `SAKLAZ-v1/approval` alanındaki onay imzaları |

Ajan, onay imzasını yalnızca onay anahtarıyla doğrular. Komut anahtarıyla atılmış bir onay `APPROVAL_WRONG_SIGNER` ile reddedilir (testli).

## Onayın kapsadığı alanlar
`approval-digest` özeti şunları kapsar:
- ajan ve telefon kimlikleri
- onay, görev ve adım kimlikleri
- araç
- risk
- özet metni
- **hedeflerin tam listesi** (dosya, program, alıcı)
- **parametrelerin tamamı** (kanonik JSON)
- ajanın rastgele challenge değeri
- verilme zamanı ve süre

Ajan, aracı çalıştırmadan hemen önce özeti gerçek parametrelerden yeniden hesaplar. Tek bir fark varsa çalıştırma `EXECUTION_PARAMS_CHANGED` ile reddedilir.
