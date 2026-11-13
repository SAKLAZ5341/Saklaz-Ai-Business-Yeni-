// SAKLAZ AI — Android kabuğu (MVP alfa).
//
// Arayüz ve bütün protokol/kriptografi, WebView'da çalışan derlenmiş arayüzdedir (assets/web/index.html,
// kaynak: apps/mobile/web). Bu kabuk yalnızca şu yerel yetenekleri sağlar:
//   • storage.*  → flutter_secure_storage (Android Keystore ile şifrelenmiş depolama)
//   • http       → yerel HTTP istemcisi (relay hesap API'si ve AI; WebView CORS kısıtı yok)
//   • qr.scan    → kamera ile QR okuma
// Dış sayfalara gezinme engellenir; WebView yalnızca paketteki arayüzü gösterir.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:webview_flutter/webview_flutter.dart';

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
      final code = e is StateError ? e.message : (e is SocketException || e is TimeoutException || e is HttpException ? 'NETWORK' : 'HOST_ERROR');
      await _reply({'id': id, 'ok': false, 'error': code});
    }
  }

  Future<Map<String, Object>> _request(Map<String, dynamic> a) async {
    final uri = Uri.parse(a['url'] as String);
    if (uri.scheme != 'https' && uri.scheme != 'http') throw StateError('URL_SCHEME');
    final method = (a['method'] as String).toUpperCase();
    if (method != 'POST' && method != 'GET') throw StateError('METHOD');
    final req = await _http.openUrl(method, uri).timeout(const Duration(seconds: 30));
    final headers = (a['headers'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
    headers.forEach((k, v) => req.headers.set(k, v.toString()));
    final body = a['body'];
    if (body is String) req.add(utf8.encode(body));
    final res = await req.close().timeout(const Duration(seconds: 120));
    final bytes = <int>[];
    await for (final chunk in res) {
      bytes.addAll(chunk);
      if (bytes.length > _maxResponseBytes) throw StateError('RESPONSE_TOO_LARGE');
    }
    return {'status': res.statusCode, 'body': utf8.decode(bytes, allowMalformed: true)};
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
