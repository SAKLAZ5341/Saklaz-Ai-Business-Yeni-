-- SAKLAZ AI relay — şema v3 (Sprint 3 A2): relay meta verisi
--
-- Gizli OLMAYAN kurulum bilgileri. Şimdilik tek kullanım: "mfa_key_check".
-- Bu değer, MFA şifreleme anahtarından türetilmiş bir HMAC'tır (anahtarın kendisi değil, anahtara
-- geri çevrilemez). Relay açılışta kendi anahtarıyla aynı değeri hesaplar; farklıysa YANLIŞ anahtarla
-- başlatılmış demektir ve relay başlamaz. Böylece yanlış anahtar, kullanıcıların girişini sessizce
-- bozmak yerine açılışta açıkça fark edilir.
--
-- Bu dosya idempotenttir.

CREATE TABLE IF NOT EXISTS relay_meta (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
