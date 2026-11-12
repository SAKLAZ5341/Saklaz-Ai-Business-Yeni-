-- =====================================================================
-- SAKLAZ AI — ASEDEN PostgreSQL katalog keşfi (SALT OKUNUR)
-- =====================================================================
-- Bu betik:
--   * İş verisi satırlarını OKUMAZ. Yalnızca sistem kataloğu ve istatistik
--     görünümlerini sorgular.
--   * Hiçbir şey YAZMAZ: oturum salt okunur moda alınır, betik ROLLBACK ile biter.
--   * ASEDEN yöneticisi tarafından, kendi onayıyla çalıştırılmalıdır.
--
-- Kullanım (yönetici):
--   psql "host=<host> dbname=<db> user=<kesif_rolu>" -X -f aseden-pg-katalog.sql -o kesif-ciktisi.txt
--
-- Çıktıdaki tablo/sütun adları ticari açıdan hassas olabilir; dosyayı gizli paylaşın.
-- Bağlantı bilgilerini ve parolaları hiçbir yere yapıştırmayın.
-- =====================================================================

\set ON_ERROR_STOP on
SET default_transaction_read_only = on;
SET statement_timeout = '15s';
SET lock_timeout = '2s';
BEGIN TRANSACTION READ ONLY;

\echo '--- 1. Sürüm ve sunucu bilgisi ---'
SELECT version();
SELECT current_database() AS veritabani, current_user AS kullanici,
       pg_is_in_recovery() AS replika_mi,
       now() AS sorgu_zamani;

\echo '--- 2. Veritabanları ve boyutları ---'
SELECT datname, pg_size_pretty(pg_database_size(datname)) AS boyut
FROM pg_database
WHERE NOT datistemplate
ORDER BY pg_database_size(datname) DESC;

\echo '--- 3. Şemalar ---'
SELECT nspname AS sema
FROM pg_namespace
WHERE nspname NOT IN ('pg_catalog', 'information_schema')
  AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'
ORDER BY 1;

\echo '--- 4. Tablolar, tahmini satır sayısı ve boyut ---'
SELECT n.nspname AS sema, c.relname AS tablo,
       CASE c.relkind WHEN 'r' THEN 'tablo' WHEN 'p' THEN 'bolumlu tablo'
                      WHEN 'v' THEN 'gorunum' WHEN 'm' THEN 'mat. gorunum' END AS tur,
       c.reltuples::bigint AS tahmini_satir,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS boyut
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, c.relname;

\echo '--- 5. CANLILIK KANITI: tablo bazında yazma istatistikleri ---'
\echo '    (Sayılar ve son analiz zamanları sürekli artıyorsa uygulama bu veritabanına yazıyor demektir.)'
SELECT schemaname AS sema, relname AS tablo,
       n_tup_ins AS eklenen, n_tup_upd AS guncellenen, n_tup_del AS silinen,
       n_live_tup AS canli_satir,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
ORDER BY (n_tup_ins + n_tup_upd + n_tup_del) DESC
LIMIT 50;

SELECT stats_reset AS istatistik_sifirlanma_zamani
FROM pg_stat_database WHERE datname = current_database();

\echo '--- 6. Aktif bağlantılar (uygulama adı ve istemci; sorgu metni GÖSTERİLMEZ) ---'
SELECT usename AS kullanici, application_name AS uygulama,
       client_addr AS istemci, state AS durum, count(*) AS adet
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY 1, 2, 3, 4
ORDER BY adet DESC;

\echo '--- 7. Sütunlar (ad ve tip; veri değil) ---'
SELECT table_schema AS sema, table_name AS tablo, ordinal_position AS sira,
       column_name AS sutun, data_type AS tip, is_nullable AS bos_olabilir
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name, ordinal_position;

\echo '--- 8. Yabancı anahtar ilişkileri ---'
SELECT conrelid::regclass AS tablo, conname AS kisit,
       confrelid::regclass AS referans_tablo,
       pg_get_constraintdef(oid) AS tanim
FROM pg_constraint
WHERE contype = 'f'
ORDER BY 1;

\echo '--- 9. Migration araçlarının izleri (yalnız tablo varlığı) ---'
SELECT n.nspname AS sema, c.relname AS tablo
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname IN ('_prisma_migrations', '__drizzle_migrations', 'knex_migrations',
                    'typeorm_migrations', 'migrations', 'SequelizeMeta', 'schema_migrations',
                    'flyway_schema_history', 'alembic_version');

\echo '--- 10. Roller ve yetki özeti (parola bilgisi YOK) ---'
SELECT rolname AS rol, rolsuper AS superuser, rolcanlogin AS giris_yapabilir,
       rolcreaterole AS rol_olusturabilir, rolcreatedb AS db_olusturabilir
FROM pg_roles
WHERE rolname NOT LIKE 'pg\_%'
ORDER BY 1;

ROLLBACK;
\echo '--- Bitti. Hiçbir değişiklik yapılmadı (ROLLBACK). ---'
