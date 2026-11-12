import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalize, CanonicalJsonError } from "../src/index.js";

describe("JCS (RFC 8785)", () => {
  it("RFC 8785 §3.2.3 anahtar sıralama örneği", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",' +
        '"€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("boşluksuz, iç içe yapılar ve kaçışlar", () => {
    expect(canonicalize({ b: [1, true, null, "x\"\\\n"], a: { d: -5, c: "" } })).toBe(
      '{"a":{"c":"","d":-5},"b":[1,true,null,"x\\"\\\\\\n"]}',
    );
  });

  it("SAKLAZ alt kümesi: kesirli sayı, -0, NaN, Sonsuz, büyük sayı reddedilir", () => {
    for (const bad of [1.5, -0, NaN, Infinity, 2 ** 53]) {
      expect(() => canonicalize({ x: bad })).toThrowError(CanonicalJsonError);
    }
  });

  it("eşsiz vekil karakter, undefined, sınıf örnekleri, bigint ve aşırı derinlik reddedilir", () => {
    expect(() => canonicalize("\ud800")).toThrowError(CanonicalJsonError);
    expect(() => canonicalize({ k: undefined })).toThrowError(CanonicalJsonError);
    expect(() => canonicalize(new Date(0))).toThrowError(CanonicalJsonError);
    expect(() => canonicalize(new Map())).toThrowError(CanonicalJsonError);
    expect(() => canonicalize(1n)).toThrowError(CanonicalJsonError);
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => canonicalize(deep)).toThrowError(/derin/);
    expect(canonicalize(Object.create(null) as object)).toBe("{}");
  });

  const jsonArb = fc.letrec((tie) => ({
    v: fc.oneof(
      { depthSize: "small" },
      fc.constant(null),
      fc.boolean(),
      fc.maxSafeInteger(),
      fc.string({ unit: "grapheme" }),
      fc.array(tie("v"), { maxLength: 4 }),
      fc.dictionary(fc.string({ unit: "grapheme", maxLength: 6 }), tie("v"), { maxKeys: 4 }),
    ),
  })).v;

  it("özellik: kararlıdır (ayrıştır→yeniden kanonikleştir aynı çıktıyı verir)", () => {
    fc.assert(
      fc.property(jsonArb, (v) => {
        const c = canonicalize(v);
        return canonicalize(JSON.parse(c)) === c;
      }),
      { numRuns: 300 },
    );
  });

  it("özellik: anahtar ekleme sırası çıktıyı değiştirmez", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 5 }), fc.maxSafeInteger(), { maxKeys: 8 }), (d) => {
        const reversed = Object.fromEntries(Object.entries(d).reverse());
        return canonicalize(d) === canonicalize(reversed);
      }),
    );
  });
});
