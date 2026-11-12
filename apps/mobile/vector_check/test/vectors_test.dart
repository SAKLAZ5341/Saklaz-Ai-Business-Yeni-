// Ortak test vektörlerini Dart tarafında doğrular.
// Vektör dosyası: packages/protocol/test-vectors/saklaz-v1.json (TypeScript tarafından üretilir).
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:saklaz_vector_check/jcs.dart';
import 'package:test/test.dart';

Uint8List hex(String s) => Uint8List.fromList(
    List.generate(s.length ~/ 2, (i) => int.parse(s.substring(i * 2, i * 2 + 2), radix: 16)));
String toHex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
Uint8List b64u(String s) => base64Url.decode(base64Url.normalize(s));
String toB64u(List<int> b) => base64Url.encode(b).replaceAll('=', '');

Uint8List framed(String domain, List<int> msg) =>
    Uint8List.fromList([...utf8.encode(domain), 0, ...msg]);

Future<Uint8List> taggedHash(String tag, List<int> data, int outLen) async {
  final h = await Blake2b(hashLengthInBytes: outLen).hash([...utf8.encode(tag), 0, ...data]);
  return Uint8List.fromList(h.bytes);
}

void main() {
  final vectors = jsonDecode(
          File('../../../packages/protocol/test-vectors/saklaz-v1.json').readAsStringSync())
      as Map<String, dynamic>;
  final ed = Ed25519();

  test('JCS vektörleri birebir aynı', () {
    for (final c in vectors['jcs'] as List) {
      expect(canonicalize((c as Map)['input']), equals(c['canonical']));
    }
  });

  test('Ed25519: tohumdan açık anahtar ve alan ayrımlı imzalar birebir aynı', () async {
    for (final s in vectors['signatures'] as List) {
      final m = s as Map;
      final kp = await ed.newKeyPairFromSeed(hex(m['seedHex'] as String));
      final pub = await kp.extractPublicKey();
      expect(toHex(pub.bytes), equals(m['publicKeyHex']));
      final sig = await ed.sign(framed(m['domain'] as String, hex(m['messageHex'] as String)), keyPair: kp);
      expect(toHex(sig.bytes), equals(m['signatureHex']));
    }
  });

  test('BLAKE2b ve etiketli özet', () async {
    final h = vectors['hashes'] as Map;
    final abc = await Blake2b().hash(utf8.encode('abc'));
    expect(toHex(abc.bytes), equals(h['blake2b512_abc']));
    expect(toHex(await taggedHash('SAKLAZ-SAS-v1', utf8.encode('abc'), 32)), equals(h['tagged_sas_32']));
  });

  test('X25519 ortak sır', () async {
    final x = vectors['x25519'] as Map;
    final alg = X25519();
    final kp = await alg.newKeyPairFromSeed(hex(x['phoneSecretHex'] as String));
    final shared = await alg.sharedSecretKey(
        keyPair: kp,
        remotePublicKey: SimplePublicKey(hex(x['agentPublicHex'] as String), type: KeyPairType.x25519));
    expect(toHex(await shared.extractBytes()), equals(x['sharedHex']));
  });

  test('İmzalı komut: imzalanan baytlar ve imza birebir aynı', () async {
    final m = vectors['message'] as Map;
    final bytes = [
      ...utf8.encode(canonicalize(m['hdr'])),
      0,
      ...utf8.encode(canonicalize(m['body'])),
    ];
    expect(toHex(bytes), equals(m['signingBytesHex']));
    final kp = await ed.newKeyPairFromSeed(hex(m['signerSeedHex'] as String));
    final sig = await ed.sign(framed('SAKLAZ-v1/msg', bytes), keyPair: kp);
    expect(toB64u(sig.bytes), equals(m['sig']));
  });

  test('İşleme bağlı onay: özet ve onay imzası birebir aynı', () async {
    final a = vectors['approval'] as Map;
    final c = a['context'] as Map;
    final digest = await taggedHash(
        'SAKLAZ-v1/approval-digest',
        utf8.encode(canonicalize({
          'v': 1,
          'agentId': c['agentId'],
          'phoneId': c['phoneId'],
          'approvalId': c['approvalId'],
          'taskId': c['taskId'],
          'stepId': c['stepId'],
          'action': c['action'],
          'challenge': c['challenge'],
          'issuedAt': c['issuedAt'],
          'expiresInSec': c['expiresInSec'],
        })),
        32);
    expect(toB64u(digest), equals(a['digest']));
    final bytes = utf8.encode(canonicalize({
      'v': 1,
      'agentId': c['agentId'],
      'phoneId': c['phoneId'],
      'approvalId': c['approvalId'],
      'digest': a['digest'],
      'decision': a['decision'],
      'challenge': c['challenge'],
    }));
    expect(toHex(bytes), equals(a['signingBytesHex']));
    final kp = await ed.newKeyPairFromSeed(hex(a['approvalSignerSeedHex'] as String));
    final sig = await ed.sign(framed('SAKLAZ-v1/approval', bytes), keyPair: kp);
    expect(toB64u(sig.bytes), equals(a['approvalSig']));
  });

  test('JCS kesirli sayı ve eşsiz vekil karakteri reddeder', () {
    expect(() => canonicalize({'x': 1.5}), throwsA(isA<CanonicalJsonError>()));
    expect(() => canonicalize('\uD800'), throwsA(isA<CanonicalJsonError>()));
  });
}
