import 'package:flutter_test/flutter_test.dart';
import 'package:saklaz_ai/net_policy.dart';

void main() {
  String code(void Function() f) {
    try {
      f();
    } on PolicyError catch (e) {
      return e.code;
    }
    return 'OK';
  }

  group('üretim yapısı (lanTest=false)', () {
    test('açık metin HTTP her hedefte reddedilir', () {
      for (final u in ['http://192.168.1.10:11434/v1/chat/completions', 'http://localhost:8080/x', 'http://relay.ornek.com/v1/auth/login']) {
        for (final p in ['relay', 'local-ai']) {
          expect(code(() => checkTarget(u, p, lanTest: false)), 'CLEARTEXT_BLOCKED', reason: '$p $u');
        }
      }
    });
    test('openai yalnızca https://api.openai.com', () {
      expect(code(() => checkTarget('https://api.openai.com/v1/responses', 'openai', lanTest: false)), 'OK');
      for (final u in ['https://api.openai.com.evil.com/v1', 'https://evil.com/v1/responses', 'https://api.openai.com:8443/v1', 'http://api.openai.com/v1']) {
        expect(code(() => checkTarget(u, 'openai', lanTest: false)), isNot('OK'), reason: u);
      }
    });
    test('local-ai yalnızca özel ağ / loopback; ad çözümlemeli dış ad yok', () {
      expect(code(() => checkTarget('https://192.168.1.10:11434/v1', 'local-ai', lanTest: false)), 'OK');
      expect(code(() => checkTarget('https://10.0.0.5/v1', 'local-ai', lanTest: false)), 'OK');
      expect(code(() => checkTarget('https://[fd12::1]:11434/v1', 'local-ai', lanTest: false)), 'OK');
      for (final u in ['https://ollama.ornek.com/v1', 'https://8.8.8.8/v1', 'https://172.32.0.1/v1', 'https://api.openai.com/v1']) {
        expect(code(() => checkTarget(u, 'local-ai', lanTest: false)), 'TARGET_NOT_ALLOWED', reason: u);
      }
    });
    test('yasak ve geçersiz hedefler', () {
      for (final u in ['https://169.254.169.254/latest', 'https://0.0.0.0/x', 'https://[::]/x', 'https://224.0.0.1/x', 'https://[fe80::1]/x', 'https://[::ffff:169.254.169.254]/x']) {
        expect(code(() => checkTarget(u, 'relay', lanTest: true)), 'TARGET_FORBIDDEN', reason: u);
      }
      expect(code(() => checkTarget('https://user:pw@relay.ornek.com/x', 'relay', lanTest: false)), 'URL_INVALID');
      expect(code(() => checkTarget('ftp://relay.ornek.com/x', 'relay', lanTest: false)), 'URL_SCHEME');
      expect(code(() => checkTarget('bozuk', 'relay', lanTest: false)), 'URL_INVALID');
      expect(code(() => checkTarget('https://relay.ornek.com/x', 'shell', lanTest: false)), 'PURPOSE_INVALID');
    });
  });

  group('yerel ağ test yapısı (lanTest=true)', () {
    test('http yalnızca özel ağ / loopback', () {
      expect(code(() => checkTarget('http://192.168.1.10:8080/v1/auth/login', 'relay', lanTest: true)), 'OK');
      expect(code(() => checkTarget('http://127.0.0.1:11434/v1', 'local-ai', lanTest: true)), 'OK');
      expect(code(() => checkTarget('http://relay.ornek.com/v1', 'relay', lanTest: true)), 'CLEARTEXT_BLOCKED');
      expect(code(() => checkTarget('http://8.8.8.8/v1', 'relay', lanTest: true)), 'CLEARTEXT_BLOCKED');
    });
  });

  test('onay: özel ağ dışı hedefler onay ister; anahtar alan ve ana makine başına', () {
    final ext = checkTarget('https://relay.ornek.com/v1/auth/login', 'relay', lanTest: false);
    expect(ext.private, isFalse);
    expect(checkTarget('https://192.168.1.2/v1', 'relay', lanTest: false).private, isTrue);
    expect(consentKey('personal', ext.uri), 'consent:personal:https://relay.ornek.com');
    expect(consentKey('business', ext.uri), isNot(consentKey('personal', ext.uri)));
    expect(consentKey('business', Uri.parse('https://relay.ornek.com:8443/x')), 'consent:business:https://relay.ornek.com:8443');
    expect(code(() => consentKey('baska', ext.uri)), 'SCOPE_INVALID');
    expect(isRedirect(302), isTrue);
    expect(isRedirect(200), isFalse);
  });

  group('WebSocket hedefi (kabukta açılır)', () {
    test('yalnızca relay amacı ve ws/wss şeması', () {
      expect(code(() => checkSocketTarget('wss://relay.ornek.com/v1/connect', 'relay', lanTest: false)), 'OK');
      expect(code(() => checkSocketTarget('wss://relay.ornek.com/v1/connect', 'openai', lanTest: false)), 'PURPOSE_INVALID');
      expect(code(() => checkSocketTarget('wss://relay.ornek.com', 'local-ai', lanTest: false)), 'PURPOSE_INVALID');
      expect(code(() => checkSocketTarget('https://relay.ornek.com', 'relay', lanTest: false)), 'URL_SCHEME');
      expect(code(() => checkSocketTarget('bozuk', 'relay', lanTest: false)), 'URL_INVALID');
    });
    test('HTTP ile aynı politika: açık metin, yasak hedef, kullanıcı bilgisi', () {
      expect(code(() => checkSocketTarget('ws://relay.ornek.com', 'relay', lanTest: false)), 'CLEARTEXT_BLOCKED');
      expect(code(() => checkSocketTarget('ws://relay.ornek.com', 'relay', lanTest: true)), 'CLEARTEXT_BLOCKED');
      expect(code(() => checkSocketTarget('ws://192.168.1.20:8080', 'relay', lanTest: false)), 'CLEARTEXT_BLOCKED');
      expect(code(() => checkSocketTarget('ws://192.168.1.20:8080', 'relay', lanTest: true)), 'OK');
      expect(code(() => checkSocketTarget('wss://169.254.169.254', 'relay', lanTest: false)), 'TARGET_FORBIDDEN');
      expect(code(() => checkSocketTarget('wss://u:p@relay.ornek.com', 'relay', lanTest: false)), 'URL_INVALID');
    });
    test('onay ve politika HTTP karşılığıyla: wss→https (relay API ile aynı onay anahtarı)', () {
      final t = checkSocketTarget('wss://relay.ornek.com/v1/connect', 'relay', lanTest: false);
      expect(t.policy.uri.scheme, 'https');
      expect(t.policy.private, isFalse);
      expect(t.socketUri.toString(), 'wss://relay.ornek.com/v1/connect');
      expect(consentKey('personal', t.policy.uri), consentKey('personal', Uri.parse('https://relay.ornek.com/v1/auth/login')));
    });
  });

  group('bağlantı sabitleme (yönlendirme ve vekil)', () {
    final vetted = Uri.parse('https://relay.ornek.com/v1/connect');
    test('aynı köken izinli', () {
      expect(connectionAllowed(vetted, Uri.parse('https://relay.ornek.com/v1/connect'), null), isTrue);
      expect(connectionAllowed(vetted, Uri.parse('https://RELAY.ornek.com:443/baska'), null), isTrue);
    });
    test('başka ana makine, bağlantı noktası, şema veya vekil reddedilir', () {
      expect(connectionAllowed(vetted, Uri.parse('https://evil.ornek.com/v1/connect'), null), isFalse);
      expect(connectionAllowed(vetted, Uri.parse('https://relay.ornek.com:8443/v1/connect'), null), isFalse);
      expect(connectionAllowed(vetted, Uri.parse('http://relay.ornek.com/v1/connect'), null), isFalse);
      expect(connectionAllowed(vetted, Uri.parse('https://192.168.1.1/'), null), isFalse);
      expect(connectionAllowed(vetted, Uri.parse('https://relay.ornek.com/v1/connect'), 'proxy.local'), isFalse);
    });
  });

  group('ağ izni dönemi (iptal)', () {
    test('iptal, öncesinde başlamış girişimleri geçersiz kılar', () {
      final e = ConsentEpoch();
      final before = e.current;
      expect(e.isCurrent(before), isTrue);
      e.revoke();
      expect(e.isCurrent(before), isFalse);
      expect(e.isCurrent(e.current), isTrue);
    });
  });
}
