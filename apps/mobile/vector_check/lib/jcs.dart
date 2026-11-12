// RFC 8785 (JCS) — SAKLAZ alt kümesi. TypeScript karşılığı: packages/protocol/src/jcs.ts
// Kurallar birebir aynıdır: yalnızca güvenli tam sayılar; anahtarlar UTF-16 kod birimine göre
// sıralanır (Dart String.compareTo bu sıralamayı uygular); metin kaçışları JSON.stringify ile aynı.
import 'dart:convert';

const int _maxSafe = 9007199254740991;

class CanonicalJsonError implements Exception {
  CanonicalJsonError(this.message);
  final String message;
  @override
  String toString() => 'CanonicalJsonError: $message';
}

String canonicalize(Object? v) {
  final sb = StringBuffer();
  _write(v, 0, sb);
  return sb.toString();
}

bool _isWellFormed(String s) {
  final u = s.codeUnits;
  for (var i = 0; i < u.length; i++) {
    final c = u[i];
    if (c >= 0xD800 && c <= 0xDBFF) {
      if (i + 1 >= u.length || u[i + 1] < 0xDC00 || u[i + 1] > 0xDFFF) return false;
      i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

String _str(String s) {
  if (!_isWellFormed(s)) throw CanonicalJsonError('Metin iyi biçimli Unicode değil.');
  return jsonEncode(s);
}

void _write(Object? v, int depth, StringBuffer sb) {
  if (depth > 32) throw CanonicalJsonError('Yapı çok derin.');
  if (v == null) {
    sb.write('null');
  } else if (v is bool) {
    sb.write(v ? 'true' : 'false');
  } else if (v is int) {
    if (v > _maxSafe || v < -_maxSafe) throw CanonicalJsonError('Güvenli tam sayı değil.');
    sb.write(v.toString());
  } else if (v is double) {
    throw CanonicalJsonError('Kesirli sayılar kabul edilmez.');
  } else if (v is String) {
    sb.write(_str(v));
  } else if (v is List) {
    sb.write('[');
    for (var i = 0; i < v.length; i++) {
      if (i > 0) sb.write(',');
      _write(v[i], depth + 1, sb);
    }
    sb.write(']');
  } else if (v is Map) {
    final keys = v.keys.cast<String>().toList()..sort();
    sb.write('{');
    for (var i = 0; i < keys.length; i++) {
      if (i > 0) sb.write(',');
      sb.write(_str(keys[i]));
      sb.write(':');
      _write(v[keys[i]], depth + 1, sb);
    }
    sb.write('}');
  } else {
    throw CanonicalJsonError('Desteklenmeyen tür: ${v.runtimeType}');
  }
}
