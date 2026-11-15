// SAKLAZ AI — Android kabuğu (MVP alfa).
//
// Arayüz ve bütün protokol/kriptografi, WebView'da çalışan derlenmiş arayüzdedir (assets/web/index.html,
// kaynak: apps/mobile/web). Bu kabuk yalnızca şu yerel yetenekleri sağlar:
//   • storage.*  → flutter_secure_storage (Android Keystore ile şifrelenmiş depolama)
//   • http       → yerel HTTP istemcisi (relay hesap API'si ve AI; WebView CORS kısıtı yok)
//   • ws.*       → relay WebSocket'i: hedef politikası ve onay HTTP ile aynı; her TCP bağlantısı onaylanan
//                  kökene sabitlenir (yönlendirme/vekil yok). Arayüzün CSP'si (connect-src 'none') WebView'ın
//                  doğrudan ağ bağlantısını engeller; ağ YALNIZCA bu kabuktan geçer.
//   • consent.clear → onaylar silinir, açık bütün soketler kapatılır (4001 CONSENT_REVOKED) ve iptalden önce
//                  başlamış onay/bağlantı girişimleri geçersiz sayılır (ConsentEpoch).
//   • qr.scan    → kamera ile QR okuma
// Dış sayfalara gezinme engellenir; WebView yalnızca paketteki arayüzü gösterir.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'net_policy.dart';

const _bg = Color(0xFF0B0E13);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const SaklazApp());
}

class SaklazApp extends StatelessWidget {
  const SaklazApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SAKLAZ AI',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(brightness: Brightness.dark, useMaterial3: true, scaffoldBackgroundColor: _bg),
      home: const HostPage(),
    );
  }
}

class HostPage extends StatefulWidget {
  const HostPage({super.key});

  @override
  State<HostPage> createState() => _HostPageState();
}

class _HostPageState extends State<HostPage> {
  late final WebViewController _web;
  final FlutterSecureStorage _storage = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  final HttpClient _http = HttpClient()..connectionTimeout = const Duration(seconds: 20);
  static const int _maxResponseBytes = 2 * 1024 * 1024;
  static const int _maxSocketMessage = 4 * 1024 * 1024;
  static const int _maxSockets = 4;
  static final RegExp _sidRe = RegExp(r'^[0-9a-f]{32}$');
  final Map<String, WebSocket> _sockets = {};
  final Set<String> _pendingSockets = {};
  final Set<String> _cancelledSockets = {};
  final ConsentEpoch _epoch = ConsentEpoch();

  @override
  void initState() {
    super.initState();
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(_bg)
      ..addJavaScriptChannel('SaklazHost', onMessageReceived: (m) => _handle(m.message))
      ..setNavigationDelegate(NavigationDelegate(
        onNavigationRequest: (r) =>
            r.url.startsWith('file:///android_asset/') ? NavigationDecision.navigate : NavigationDecision.prevent,
      ))
      ..loadFlutterAsset('assets/web/index.html');
  }

  @override
  void dispose() {
    _epoch.revoke();
    for (final ws in _sockets.values) {
      ws.close(1001, 'dispose');
    }
    _sockets.clear();
    _http.close(force: true);
    super.dispose();
  }

  Future<void> _handle(String raw) async {
    int id = -1;
    try {
      final msg = jsonDecode(raw) as Map<String, dynamic>;
      id = (msg['id'] as num).toInt();
      final op = msg['op'] as String;
      final args = (msg['args'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
      final Object? value;
      switch (op) {
        case 'storage.get':
          value = await _storage.read(key: args['key'] as String);
          break;
        case 'storage.set':
          await _storage.write(key: args['key'] as String, value: args['value'] as String);
          value = null;
          break;
        case 'storage.delete':
          await _storage.delete(key: args['key'] as String);
          value = null;
          break;
        case 'http':
          value = await _request(args);
          break;
        case 'host.info':
          value = {'lanTest': kLanTest, 'version': '0.1.0-alpha'};
          break;
        case 'ws.open':
          await _openSocket(args);
          value = null;
          break;
        case 'ws.send':
          final sendTo = _sockets[args['sid']];
          final data = args['data'];
          if (sendTo == null) throw StateError('SOCKET_NOT_OPEN');
          if (data is! String || data.length > _maxSocketMessage) throw StateError('SOCKET_MESSAGE');
          sendTo.add(data);
          value = null;
          break;
        case 'ws.close':
          final closeSid = args['sid'];
          if (closeSid is String && _pendingSockets.contains(closeSid)) _cancelledSockets.add(closeSid);
          final closing = _sockets.remove(closeSid);
          final c = args['code'];
          final closeCode = c is num && (c.toInt() == 1000 || (c.toInt() >= 3000 && c.toInt() <= 4999)) ? c.toInt() : 1000;
          await closing?.close(closeCode, 'client');
          value = null;
          break;
        case 'consent.clear':
          // Önce dönem artırılır ve soketler kapatılır: bekleyen onay penceresi/bağlantı tamamlansa bile geçersizdir.
          _epoch.revoke();
          for (final sid in _sockets.keys.toList()) {
            final revoked = _sockets.remove(sid);
            await revoked?.close(4001, 'CONSENT_REVOKED');
            await _socketEvent({'sid': sid, 'ev': 'close', 'code': 4001, 'reason': 'CONSENT_REVOKED'});
          }
          final all = await _storage.readAll();
          for (final k in all.keys.where((k) => k.startsWith('consent:'))) {
            await _storage.delete(key: k);
          }
          value = null;
          break;
        case 'qr.scan':
          if (!mounted) throw StateError('UNMOUNTED');
          value = await Navigator.of(context).push<String?>(MaterialPageRoute(builder: (_) => const ScannerPage()));
          break;
        default:
          throw StateError('UNKNOWN_OP');
      }
      await _reply({'id': id, 'ok': true, 'value': value});
    } catch (e) {
      // Hata ayrıntısı (anahtar, adres, yanıt gövdesi) arayüze taşınmaz; yalnızca kısa kod.
      final code = e is StateError
          ? e.message
          : e is PolicyError
              ? e.code
              : (e is SocketException || e is TimeoutException || e is HttpException || e is WebSocketException ? 'NETWORK' : 'HOST_ERROR');
      await _reply({'id': id, 'ok': false, 'error': code});
    }
  }

  // Onay pencereleri sırayla gösterilir (aynı anda birden çok istek gelse bile).
  Future<void> _consentChain = Future.value();

  Future<void> _ensureConsent(NetTarget t, String scope, String purpose, int epoch) {
    if (t.private) return Future.value(); // yerel ağ / loopback: cihazın ağından çıkmaz
    final key = consentKey(scope, purpose, t.uri);
    final run = _consentChain.then((_) async {
      if (!_epoch.isCurrent(epoch)) throw StateError('CONSENT_REVOKED');
      if (await _storage.read(key: key) == 'yes') return;
      if (!mounted) throw StateError('UNMOUNTED');
      final business = scope == 'business';
      final what = purpose == 'openai' ? 'yapay zekâ isteği (yazdığınız metin)' : purpose == 'relay' ? 'hesap ve bağlantı istekleri' : 'yapay zekâ isteği';
      final ok = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          title: Text(business ? 'KURUMSAL alan: dış sunucuya gönderim' : 'Dış sunucuya gönderim'),
          content: Text('${t.uri.scheme}://${t.uri.host}${t.uri.hasPort ? ':${t.uri.port}' : ''}\n\n'
              '${_isShared(t.uri) ? 'Bu adres yerel ağ DEĞİL: operatör/VPN ortak ağı (100.64.0.0/10). ' : ''}'
              'Bu adrese $what gönderilecek. '
              '${business ? 'Kurumsal veri bu sunucuya gidebilir. ' : ''}'
              'İzin verirseniz bu alan için hatırlanır (Ayarlar → Ağ izinlerini sıfırla).'),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Reddet')),
            FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('İzin ver')),
          ],
        ),
      );
      if (ok != true) throw StateError('HOST_DENIED');
      // Pencere açıkken izinler sıfırlandıysa bu onay YAZILMAZ.
      if (!_epoch.isCurrent(epoch)) throw StateError('CONSENT_REVOKED');
      await _storage.write(key: key, value: 'yes');
    });
    _consentChain = run.catchError((_) {});
    return run;
  }

  static bool _isShared(Uri u) {
    final ip = InternetAddress.tryParse(u.host);
    return ip != null && isSharedAddress(ip);
  }

  Future<Map<String, Object>> _request(Map<String, dynamic> a) async {
    final purpose = a['purpose'];
    final scope = a['scope'];
    if (purpose is! String || scope is! String || !kScopes.contains(scope)) throw StateError('PURPOSE_INVALID');
    final target = checkTarget(a['url'] as String, purpose, lanTest: kLanTest);
    final uri = target.uri;
    final method = (a['method'] as String).toUpperCase();
    if (method != 'POST' && method != 'GET') throw StateError('METHOD');
    final epoch = _epoch.current;
    await _ensureConsent(target, scope, purpose, epoch);
    if (!_epoch.isCurrent(epoch)) throw StateError('CONSENT_REVOKED');
    final req = await _http.openUrl(method, uri).timeout(const Duration(seconds: 30));
    // Yönlendirme izlenmez: yeni hedef politikadan ve onaydan geçmemiş olur.
    req.followRedirects = false;
    req.maxRedirects = 0;
    final headers = (a['headers'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
    headers.forEach((k, v) => req.headers.set(k, v.toString()));
    final body = a['body'];
    if (body is String) req.add(utf8.encode(body));
    final res = await req.close().timeout(const Duration(seconds: 120));
    if (isRedirect(res.statusCode)) {
      await res.drain<void>();
      throw StateError('REDIRECT_BLOCKED');
    }
    final bytes = <int>[];
    await for (final chunk in res) {
      bytes.addAll(chunk);
      if (bytes.length > _maxResponseBytes) throw StateError('RESPONSE_TOO_LARGE');
    }
    return {'status': res.statusCode, 'body': utf8.decode(bytes, allowMalformed: true)};
  }

  /// Relay WebSocket'i: politika → onay → kökene sabitlenmiş bağlantı. Yalnızca metin çerçeveleri.
  Future<void> _openSocket(Map<String, dynamic> a) async {
    final sid = a['sid'];
    if (sid is! String || !_sidRe.hasMatch(sid) || _sockets.containsKey(sid) || _pendingSockets.contains(sid)) {
      throw StateError('SOCKET_ID');
    }
    if (_sockets.length + _pendingSockets.length >= _maxSockets) throw StateError('SOCKET_LIMIT');
    final purpose = a['purpose'];
    final scope = a['scope'];
    final url = a['url'];
    if (purpose is! String || scope is! String || !kScopes.contains(scope) || url is! String) {
      throw PolicyError('PURPOSE_INVALID');
    }
    final t = checkSocketTarget(url, purpose, lanTest: kLanTest);
    final epoch = _epoch.current;
    _pendingSockets.add(sid);
    try {
      await _ensureConsent(t.policy, scope, purpose, epoch);
      if (!_epoch.isCurrent(epoch) || !mounted) throw StateError('CONSENT_REVOKED');
      final client = HttpClient()
        ..connectionTimeout = const Duration(seconds: 20)
        ..findProxy = (_) => 'DIRECT';
      // Yönlendirme dahil her bağlantı yalnızca onaylanan kökene: başka hedefe giden bağlantı açılmaz.
      client.connectionFactory = (Uri uri, String? proxyHost, int? proxyPort) {
        if (!connectionAllowed(t.policy.uri, uri, proxyHost)) {
          return Future<ConnectionTask<Socket>>.error(PolicyError('REDIRECT_BLOCKED'));
        }
        return uri.scheme == 'https' ? SecureSocket.startConnect(uri.host, uri.port) : Socket.startConnect(uri.host, uri.port);
      };
      final WebSocket ws;
      try {
        ws = await WebSocket.connect(t.socketUri.toString(), customClient: client).timeout(const Duration(seconds: 30));
      } finally {
        client.close();
      }
      if (!_epoch.isCurrent(epoch) || !mounted) {
        await ws.close(4001, 'CONSENT_REVOKED');
        throw StateError('CONSENT_REVOKED');
      }
      if (_cancelledSockets.contains(sid)) {
        await ws.close(1000, 'client');
        throw StateError('SOCKET_CLOSED');
      }
      _sockets[sid] = ws;
      void closed(int code, String reason) {
        if (_sockets.remove(sid) != null) {
          _socketEvent({'sid': sid, 'ev': 'close', 'code': code, 'reason': reason});
        }
      }

      ws.listen(
        (dynamic data) {
          if (data is! String || data.length > _maxSocketMessage) {
            closed(1009, 'MESSAGE');
            ws.close(1009, 'MESSAGE');
            return;
          }
          _socketEvent({'sid': sid, 'ev': 'message', 'data': data});
        },
        onError: (Object _) => closed(1006, 'ERROR'),
        onDone: () => closed(ws.closeCode ?? 1006, ''),
        cancelOnError: true,
      );
      await _socketEvent({'sid': sid, 'ev': 'open'});
    } finally {
      _pendingSockets.remove(sid);
      _cancelledSockets.remove(sid);
    }
  }

  Future<void> _socketEvent(Map<String, Object?> e) {
    if (!mounted) return Future.value();
    return _web.runJavaScript('window.__saklazWsEvent && window.__saklazWsEvent(${jsonEncode(jsonEncode(e))})');
  }

  Future<void> _reply(Map<String, Object?> r) {
    // JSON metni, JS dizgesi olarak güvenle kaçışlanır (jsonEncode iki kez).
    return _web.runJavaScript('window.__saklazReply && window.__saklazReply(${jsonEncode(jsonEncode(r))})');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(body: SafeArea(child: WebViewWidget(controller: _web)));
  }
}

class ScannerPage extends StatefulWidget {
  const ScannerPage({super.key});

  @override
  State<ScannerPage> createState() => _ScannerPageState();
}

class _ScannerPageState extends State<ScannerPage> {
  bool _done = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Eşleştirme kodunu okutun'), backgroundColor: _bg),
      body: MobileScanner(
        onDetect: (capture) {
          if (_done || capture.barcodes.isEmpty) return;
          final v = capture.barcodes.first.rawValue;
          if (v == null || !v.startsWith('SAKLAZ1:')) return;
          _done = true;
          Navigator.of(context).pop(v);
        },
      ),
    );
  }
}
