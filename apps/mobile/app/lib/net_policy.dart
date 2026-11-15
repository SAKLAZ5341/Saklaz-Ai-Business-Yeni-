// SAKLAZ AI — Android kabuğu ağ hedef politikası (saf Dart; test/net_policy_test.dart ile sınanır).
//
// Arayüz (WebView) her HTTP isteğini bir AMAÇ ile ister: relay, openai, local-ai. Kabuk hedefi burada
// doğrular; arayüzdeki bir hata veya kötü niyetli içerik bu kuralları aşamaz.
//   • Açık metin HTTP yalnızca yerel ağ TEST yapısında (SAKLAZ_LAN_TEST) ve yalnızca özel/loopback adreslere.
//   • openai  → yalnızca https://api.openai.com
//   • local-ai → yalnızca özel ağ / loopback IP adresleri veya "localhost" (ad çözümlemesiyle dışarı kaçış yok)
//   • relay   → https (test yapısında özel ağdaki http de)
//   • Hiçbir amaçta: kullanıcı bilgisi içeren adres, bağlantı-yerel / bulut meta veri (169.254/16),
//     belirsiz (0.0.0.0, ::), çok noktaya yayın adresleri.
//   • Özel ağ dışındaki her hedef, alan (kişisel/kurumsal) başına ayrı, AÇIK kullanıcı onayı ister.
import 'dart:io';

/// Derleme zamanı bayrağı: `flutter build apk --dart-define=SAKLAZ_LAN_TEST=true`.
const bool kLanTest = bool.fromEnvironment('SAKLAZ_LAN_TEST');

class PolicyError implements Exception {
  PolicyError(this.code);
  final String code;
  @override
  String toString() => code;
}

class NetTarget {
  NetTarget(this.uri, {required this.private});
  final Uri uri;

  /// Özel ağ / loopback hedefi: cihazın yerel ağından çıkmaz; onay gerektirmez.
  final bool private;
}

const Set<String> kPurposes = {'relay', 'openai', 'local-ai'};
const Set<String> kScopes = {'personal', 'business'};

/// IPv4/IPv6 özel ağ ve loopback aralıkları (RFC 1918, RFC 6598 CGNAT, RFC 4193 ULA).
bool isPrivateAddress(InternetAddress ip) {
  final b = ip.rawAddress;
  if (ip.type == InternetAddressType.IPv4) {
    if (b[0] == 10 || b[0] == 127) return true;
    if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return true;
    if (b[0] == 192 && b[1] == 168) return true;
    if (b[0] == 100 && b[1] >= 64 && b[1] <= 127) return true;
    return false;
  }
  if (ip.isLoopback) return true;
  if ((b[0] & 0xfe) == 0xfc) return true; // fc00::/7
  return false;
}

/// Hiçbir amaçla kullanılamayacak adresler.
bool isForbiddenAddress(InternetAddress ip) {
  final b = ip.rawAddress;
  if (ip.isLinkLocal || ip.isMulticast) return true;
  if (ip.type == InternetAddressType.IPv4) {
    if (b.every((x) => x == 0)) return true; // 0.0.0.0
    if (b.every((x) => x == 255)) return true; // yayın
    if (b[0] == 169 && b[1] == 254) return true; // bağlantı-yerel, bulut meta veri
    if (b[0] == 0) return true;
    return false;
  }
  if (b.every((x) => x == 0)) return true; // ::
  // IPv4 eşlemeli IPv6 (::ffff:a.b.c.d): IPv4 kurallarıyla değerlendirilir
  if (b.sublist(0, 10).every((x) => x == 0) && b[10] == 0xff && b[11] == 0xff) {
    final v4 = InternetAddress.fromRawAddress(b.sublist(12), type: InternetAddressType.IPv4);
    return isForbiddenAddress(v4);
  }
  return false;
}

NetTarget checkTarget(String url, String purpose, {required bool lanTest}) {
  if (!kPurposes.contains(purpose)) throw PolicyError('PURPOSE_INVALID');
  final uri = Uri.tryParse(url);
  if (uri == null || !uri.hasScheme || uri.host.isEmpty) throw PolicyError('URL_INVALID');
  if (uri.userInfo.isNotEmpty || uri.hasFragment) throw PolicyError('URL_INVALID');
  final scheme = uri.scheme.toLowerCase();
  if (scheme != 'https' && scheme != 'http') throw PolicyError('URL_SCHEME');
  final host = uri.host.toLowerCase();
  final ip = InternetAddress.tryParse(host);
  if (ip != null && isForbiddenAddress(ip)) throw PolicyError('TARGET_FORBIDDEN');
  final private = host == 'localhost' || (ip != null && isPrivateAddress(ip));
  if (scheme == 'http' && !(lanTest && private)) throw PolicyError('CLEARTEXT_BLOCKED');
  switch (purpose) {
    case 'openai':
      if (scheme != 'https' || host != 'api.openai.com' || (uri.hasPort && uri.port != 443)) {
        throw PolicyError('TARGET_NOT_ALLOWED');
      }
      break;
    case 'local-ai':
      if (!private) throw PolicyError('TARGET_NOT_ALLOWED');
      break;
    case 'relay':
      break;
  }
  return NetTarget(uri, private: private);
}

/// Dış hedef için onay anahtarı: alan (kişisel/kurumsal) ve ana makine başına ayrı.
String consentKey(String scope, Uri uri) {
  if (!kScopes.contains(scope)) throw PolicyError('SCOPE_INVALID');
  final port = uri.hasPort ? ':${uri.port}' : '';
  return 'consent:$scope:${uri.scheme}://${uri.host.toLowerCase()}$port';
}

bool isRedirect(int status) => status >= 300 && status < 400;

/// WebSocket hedefi: yalnızca relay amacı; wss (test yapısında özel ağdaki ws de). Politika ve onay,
/// aynı kökenin HTTP karşılığıyla (wss→https, ws→http) değerlendirilir — relay API'si ile soketi tek onay.
class SocketTarget {
  SocketTarget(this.policy, this.socketUri);

  /// Politika/onay için HTTP karşılığı (checkTarget sonucu).
  final NetTarget policy;

  /// Bağlanılacak ws/wss adresi.
  final Uri socketUri;
}

SocketTarget checkSocketTarget(String url, String purpose, {required bool lanTest}) {
  if (purpose != 'relay') throw PolicyError('PURPOSE_INVALID');
  final uri = Uri.tryParse(url);
  if (uri == null || !uri.hasScheme || uri.host.isEmpty) throw PolicyError('URL_INVALID');
  final scheme = uri.scheme.toLowerCase();
  if (scheme != 'wss' && scheme != 'ws') throw PolicyError('URL_SCHEME');
  final policy = checkTarget(uri.replace(scheme: scheme == 'wss' ? 'https' : 'http').toString(), purpose, lanTest: lanTest);
  return SocketTarget(policy, uri);
}

/// Bağlantı sabitleme: soket için açılan HER TCP bağlantısı (yönlendirme dahil) yalnızca politikadan ve
/// onaydan geçmiş kökene (şema + ana makine + bağlantı noktası) gidebilir; vekil sunucu kullanılmaz.
bool connectionAllowed(Uri vetted, Uri requested, String? proxyHost) {
  if (proxyHost != null) return false;
  return requested.scheme.toLowerCase() == vetted.scheme.toLowerCase() &&
      requested.host.toLowerCase() == vetted.host.toLowerCase() &&
      requested.port == vetted.port;
}

/// Ağ izni dönemi: "Ağ izinlerini sıfırla" dönemi artırır. İptalden ÖNCE başlamış bir onay penceresi veya
/// bağlantı girişimi, tamamlandığında dönem değiştiği için geçersiz sayılır (onay yazılmaz, soket kapatılır).
class ConsentEpoch {
  int _value = 0;
  int get current => _value;
  void revoke() => _value++;
  bool isCurrent(int epoch) => epoch == _value;
}
