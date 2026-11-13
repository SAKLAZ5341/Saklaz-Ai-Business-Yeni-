#!/bin/sh
# SAKLAZ AI relay — bir çalışma alanı için gizli bilgileri üretir (Sprint 3 A2).
#
# Kullanım (sunucuda, root olarak):
#   sudo infra/relay/scripts/init-secrets.sh /etc/saklaz/personal
#   sudo infra/relay/scripts/init-secrets.sh /etc/saklaz/business
#
# Her çalışma alanının AYRI klasörü ve AYRI anahtarları olmalıdır; klasörler paylaşılmaz/kopyalanmaz.
#
# Güvenlik kuralları:
#   • Var olan hiçbir dosyanın üzerine YAZMAZ. MFA anahtarı kaybolursa veya değişirse bütün
#     kullanıcıların TOTP kaydı geçersiz olur; JWT anahtarı değişirse bütün oturumlar düşer.
#     Anahtar yenileme ayrı ve planlı bir işlemdir (docs/deploy/RELAY-DAGITIM-GUVENLIGI.md).
#   • Klasör 0700 (yalnızca root). Relay'e ait dosyalar relay kullanıcısına (uid 1000) ait ve 0400.
#     Veritabanı parolası hem relay (uid 1000) hem PostgreSQL (uid 999) tarafından okunduğu için
#     0444'tür; korunması 0700 klasöre dayanır (sunucudaki diğer kullanıcılar klasöre giremez).
#   • Hiçbir değer ekrana veya günlüğe yazılmaz.
#   • Bu dosyalar YEDEKLENMELİDİR (şifreli, sunucu dışında). Yedeksiz MFA anahtarı = kalıcı kayıp.
set -eu
umask 077

DIR="${1:-}"
RELAY_UID="${SAKLAZ_RELAY_UID:-1000}"
if [ -z "$DIR" ]; then
  echo "kullanım: $0 <gizli-bilgi-klasörü>" >&2
  exit 2
fi
command -v openssl >/dev/null 2>&1 || { echo "openssl gerekli" >&2; exit 2; }

mkdir -p "$DIR"
chmod 0700 "$DIR"

for f in db_password jwt_private.pem jwt_public.pem mfa_key.hex; do
  if [ -e "$DIR/$f" ]; then
    echo "HATA: $DIR/$f zaten var; üzerine yazılmaz. Anahtar yenileme ayrı bir işlemdir." >&2
    exit 1
  fi
done

# Veritabanı parolası: 32 rastgele bayt, URL'de sorun çıkarmayan karakterler.
openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48 > "$DIR/db_password"
# JWT: Ed25519 anahtar çifti
openssl genpkey -algorithm ed25519 -out "$DIR/jwt_private.pem" 2>/dev/null
openssl pkey -in "$DIR/jwt_private.pem" -pubout -out "$DIR/jwt_public.pem" 2>/dev/null
# MFA sırlarını şifreleyen anahtar: 32 rastgele bayt (hex)
openssl rand -hex 32 > "$DIR/mfa_key.hex"

chmod 0400 "$DIR/jwt_private.pem" "$DIR/jwt_public.pem" "$DIR/mfa_key.hex"
chmod 0444 "$DIR/db_password"
if [ "$(id -u)" = "0" ]; then
  chown "$RELAY_UID:$RELAY_UID" "$DIR/jwt_private.pem" "$DIR/jwt_public.pem" "$DIR/mfa_key.hex"
  chown root:root "$DIR/db_password" "$DIR"
  # İsteğe bağlı: Compose root olmayan bir yönetici grubuyla (ör. "docker") çalıştırılıyorsa, o gruba
  # klasör için YALNIZCA geçiş izni (0710) verilir: dosya adlarını listeleyemez; relay anahtarları
  # (0400, sahibi uid 1000) okunamaz. db_password (0444) ise adı bilinirse okunabilir. Bu yeni bir
  # yetki değildir: "docker" grubu üyeliği zaten root'a eşdeğerdir (her konteyneri ve dosyayı açabilir).
  # Bu yüzden "docker" grubuna yalnızca sunucu yöneticileri alınmalıdır.
  if [ -n "${SAKLAZ_SECRETS_DIR_GROUP:-}" ]; then
    chgrp "$SAKLAZ_SECRETS_DIR_GROUP" "$DIR"
    chmod 0710 "$DIR"
  fi
else
  echo "UYARI: root değilsiniz; relay dosyalarının sahibi uid $RELAY_UID yapılamadı." >&2
  echo "       Konteyner bu dosyaları okuyamazsa: sudo chown $RELAY_UID:$RELAY_UID $DIR/jwt_*.pem $DIR/mfa_key.hex" >&2
fi
echo "Gizli bilgiler üretildi: $DIR (değerler gösterilmez). Bu klasörü şifreli olarak yedekleyin."
