-- SAKLAZ AI relay — şema v2 (Sprint 3 A1): TOTP tekrar kullanım koruması
--
-- totp_last_step: bu hesapta başarılı bir girişte tüketilmiş en yüksek TOTP zaman adımı
-- (Unix zamanı / 30 sn). Bir kod yalnızca adımı bu değerden BÜYÜKSE kabul edilir; karşılaştırma ve
-- güncelleme tek bir koşullu UPDATE ile atomik yapılır. Değer veritabanında tutulduğu için sunucu
-- yeniden başlatıldığında koruma sürer.
--
-- Bu dosya her açılışta yeniden çalıştırılır; bu yüzden idempotent yazılmıştır.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_last_step bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_totp_last_step_nonneg') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_totp_last_step_nonneg CHECK (totp_last_step IS NULL OR totp_last_step >= 0);
  END IF;
END
$$;
