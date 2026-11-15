import { describe, expect, it } from "vitest";
import { AiError, aiErrorText, chat, defaultAiSettings, extractResponsesText, MODES } from "../src/ai.js";
import { hostFetch, Store, validateRelay } from "../src/app.js";
import type { Host, HttpContext, HttpResponse } from "../src/host.js";
import { isForbiddenHost, isPrivateHost, isSharedHost, validateLocalAiUrl } from "../src/netpolicy.js";

class MemHost implements Host {
  readonly kind = "android" as const;
  readonly m = new Map<string, string>();
  calls: { url: string; method: string; headers: Record<string, string>; body?: string; ctx: HttpContext }[] = [];
  next: HttpResponse | Error = { status: 200, body: "{}" };
  lanTest = false;
  cleared = 0;
  get(k: string) {
    return Promise.resolve(this.m.get(k) ?? null);
  }
  set(k: string, v: string) {
    this.m.set(k, v);
    return Promise.resolve();
  }
  remove(k: string) {
    this.m.delete(k);
    return Promise.resolve();
  }
  http(url: string, method: string, headers: Record<string, string>, body: string | undefined, ctx: HttpContext) {
    this.calls.push({ url, method, headers, ctx, ...(body !== undefined ? { body } : {}) });
    return this.next instanceof Error ? Promise.reject(this.next) : Promise.resolve(this.next);
  }
  info() {
    return Promise.resolve({ lanTest: this.lanTest });
  }
  clearConsents() {
    this.cleared++;
    return Promise.resolve();
  }
  scanQr() {
    return Promise.resolve(null);
  }
  openSocket(): never {
    throw new Error("bu testte kullanılmaz");
  }
}

describe("relay adresi", () => {
  it("wss zorunlu; ws yalnızca yerel ağ TEST yapısında, işaretliyse ve yerel ağ adresine", () => {
    expect(validateRelay(" wss://relay.ornek.com/v1/connect ", false)).toBe("wss://relay.ornek.com");
    expect(() => validateRelay("ws://10.0.0.2:8080", false, true)).toThrow("RELAY_URL_INSECURE");
    expect(() => validateRelay("ws://10.0.0.2:8080", true, false)).toThrow("RELAY_URL_INSECURE"); // üretim yapısı
    expect(validateRelay("ws://10.0.0.2:8080", true, true)).toBe("ws://10.0.0.2:8080");
    expect(() => validateRelay("ws://relay.ornek.com", true, true)).toThrow("RELAY_URL_NOT_LOCAL");
    expect(() => validateRelay("wss://u:p@relay.ornek.com", false)).toThrow("RELAY_URL_INVALID");
    expect(() => validateRelay("wss://169.254.169.254", false)).toThrow("RELAY_URL_INVALID");
    expect(() => validateRelay("https://x.com", true)).toThrow("RELAY_URL_INVALID");
    expect(() => validateRelay("bozuk", true)).toThrow("RELAY_URL_INVALID");
  });
});

describe("Store: profil izolasyonu", () => {
  it("profil verileri ayrı anahtar alanında; profil silinince bütün verisi silinir", async () => {
    const h = new MemHost();
    const s = new Store(h);
    const a = { id: "ws_aaaaaaaaaaaaaaaaaaaa", name: "Ev", kind: "personal" as const, relayUrl: "wss://a", email: "a@b.co", insecure: false };
    const b = { ...a, id: "ws_bbbbbbbbbbbbbbbbbbbb", name: "Şirket", kind: "business" as const };
    await s.saveProfile(a);
    await s.saveProfile(b);
    await s.saveProfile({ ...a, name: "Ev 2" });
    expect((await s.profiles()).map((p) => p.name).sort()).toEqual(["Ev 2", "Şirket"]);
    await s.pput(a.id, "notes", [{ id: "1", text: "kişisel not", ts: 1 }]);
    await s.setSecret(a.id, "aikey", "sk-test");
    await s.pput(b.id, "notes", []);
    expect(await s.pget(b.id, "notes", null)).toEqual([]);
    expect(await s.secret(b.id, "aikey")).toBeNull();
    await h.set("active", a.id);
    await s.deleteProfile(a.id);
    expect([...h.m.keys()].some((k) => k.includes(a.id))).toBe(false);
    expect(await h.get("active")).toBeNull();
    expect((await s.profiles()).map((p) => p.id)).toEqual([b.id]);
    await h.set("bozuk", "{");
    expect(await s.json("bozuk", 7)).toBe(7);
  });

  it("hostFetch: kabuk HTTP yanıtını fetch biçimine çevirir", async () => {
    const h = new MemHost();
    h.next = { status: 201, body: '{"ok":true}' };
    const r = await hostFetch(h, "business")("https://x/v1/a", { method: "POST", headers: { a: "b" }, body: "{}" });
    expect(h.calls[0]?.ctx).toEqual({ purpose: "relay", scope: "business" });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ ok: true });
    h.next = { status: 204, body: "" };
    expect(await (await hostFetch(h, "personal")("https://x", { method: "GET", headers: {} })).json()).toEqual({});
    // kabuk politika/onay reddi: kod korunur (RelayApi bunu hata kodu olarak görür)
    h.next = new Error("HOST_DENIED");
    const denied = await hostFetch(h, "personal")("https://x", { method: "POST", headers: {} });
    expect(denied.status).toBe(499);
    expect(await denied.json()).toEqual({ error: "HOST_DENIED" });
    h.next = new Error("ağ koptu");
    await expect(hostFetch(h, "personal")("https://x", { method: "POST", headers: {} })).rejects.toThrow("ağ koptu");
  });
});

describe("ağ hedef kuralları (arayüz tarafı; asıl denetim kabukta)", () => {
  it("özel ağ ve yasak adresler", () => {
    for (const h of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "127.0.0.1", "localhost", "[::1]", "[fd12::1]"]) expect(isPrivateHost(h), h).toBe(true);
    // CGNAT (100.64.0.0/10) otomatik güvenilir değil: özel ağ sayılmaz, paylaşılan adres olarak ayrılır
    for (const h of ["100.64.0.1", "100.100.100.100", "100.127.255.254"]) {
      expect(isPrivateHost(h), h).toBe(false);
      expect(isSharedHost(h), h).toBe(true);
    }
    for (const h of ["100.63.255.255", "100.128.0.1", "10.0.0.1"]) expect(isSharedHost(h), h).toBe(false);
    for (const h of ["8.8.8.8", "172.32.0.1", "api.openai.com", "ollama.ornek.com", "192.169.0.1"]) expect(isPrivateHost(h), h).toBe(false);
    for (const h of ["169.254.169.254", "0.0.0.0", "224.0.0.1", "[::]", "[fe80::1]", "[::ffff:169.254.169.254]"]) expect(isForbiddenHost(h), h).toBe(true);
    expect(isForbiddenHost("192.168.1.1")).toBe(false);
  });
  it("yerel AI adresi: yalnızca yerel ağ; http yalnızca test yapısında", () => {
    expect(validateLocalAiUrl("https://192.168.1.10:11434/v1/", false)).toBe("https://192.168.1.10:11434/v1");
    expect(validateLocalAiUrl("http://192.168.1.10:11434/v1", true)).toBe("http://192.168.1.10:11434/v1");
    expect(() => validateLocalAiUrl("http://192.168.1.10:11434/v1", false)).toThrow("CLEARTEXT_BLOCKED");
    expect(() => validateLocalAiUrl("https://ollama.ornek.com/v1", true)).toThrow("TARGET_NOT_ALLOWED");
    expect(() => validateLocalAiUrl("https://169.254.169.254/v1", true)).toThrow("TARGET_FORBIDDEN");
    expect(() => validateLocalAiUrl("ftp://10.0.0.1/v1", true)).toThrow("URL_SCHEME");
    expect(() => validateLocalAiUrl("https://a:b@10.0.0.1/v1", true)).toThrow("URL_INVALID");
    expect(() => validateLocalAiUrl("bozuk", true)).toThrow("URL_INVALID");
  });
  it("CGNAT: yerel AI yalnızca https ile (kabuk onay ister); açık metin test yapısında bile yok; relay ws yok", () => {
    expect(validateLocalAiUrl("https://100.101.2.3:11434/v1", false)).toBe("https://100.101.2.3:11434/v1");
    expect(() => validateLocalAiUrl("http://100.101.2.3:11434/v1", true)).toThrow("CLEARTEXT_BLOCKED");
    expect(() => validateRelay("ws://100.100.1.1:8080", true, true)).toThrow("RELAY_URL_NOT_LOCAL");
    expect(validateRelay("wss://100.100.1.1", false)).toBe("wss://100.100.1.1");
  });
});

describe("AI", () => {
  it("kurumsal alanda bulut varsayılan kapalı; anahtar yoksa sahte yanıt yok", async () => {
    const h = new MemHost();
    const biz = defaultAiSettings(true);
    expect(biz).toMatchObject({ provider: "local", allowCloud: false });
    await expect(chat(h, { ...biz, provider: "openai" }, "sk", "general", [{ role: "user", text: "x" }], true)).rejects.toMatchObject({ code: "CLOUD_BLOCKED" });
    await expect(chat(h, defaultAiSettings(false), null, "general", [], false)).rejects.toMatchObject({ code: "NO_KEY" });
    await expect(chat(h, biz, null, "general", [], true)).rejects.toMatchObject({ code: "NO_LOCAL_URL" });
    expect(h.calls).toEqual([]); // hiçbir istek gitmedi
  });

  it("OpenAI Responses API isteği ve yanıt ayrıştırma", async () => {
    const h = new MemHost();
    h.next = { status: 200, body: JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "Merhaba" }] }] }) };
    const out = await chat(h, defaultAiSettings(false), "sk-gizli", "purchase", [{ role: "user", text: "teklif" }], false);
    expect(out).toBe("Merhaba");
    const c = h.calls[0];
    expect(c?.url).toBe("https://api.openai.com/v1/responses");
    expect(c?.headers["authorization"]).toBe("Bearer sk-gizli");
    const body = JSON.parse(c?.body ?? "{}") as { instructions: string; store: boolean; input: unknown[] };
    expect(body.instructions).toBe(MODES.purchase.prompt);
    expect(body.store).toBe(false);
    expect(extractResponsesText('{"output_text":"kısa"}')).toBe("kısa");
    expect(() => extractResponsesText("{}")).toThrow(AiError);
    h.next = { status: 401, body: '{"error":{"message":"Incorrect API key"}}' };
    await expect(chat(h, defaultAiSettings(false), "sk", "general", [], false)).rejects.toMatchObject({ code: "API_ERROR", detail: "401: Incorrect API key" });
    h.next = new Error("ağ");
    await expect(chat(h, defaultAiSettings(false), "sk", "general", [], false)).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("yerel (OpenAI uyumlu) sağlayıcı ve hata metinleri", async () => {
    const h = new MemHost();
    h.lanTest = true;
    const s = { ...defaultAiSettings(true), localUrl: "http://10.0.0.5:11434/v1/" };
    h.next = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "Yerel yanıt" } }] }) };
    expect(await chat(h, s, null, "meeting", [{ role: "user", text: "not" }], true)).toBe("Yerel yanıt");
    expect(h.calls[0]?.url).toBe("http://10.0.0.5:11434/v1/chat/completions");
    expect(h.calls[0]?.ctx).toEqual({ purpose: "local-ai", scope: "business" });
    expect(h.calls[0]?.headers["authorization"]).toBeUndefined();
    // üretim yapısında http yerel AI, dış ad ve kabuk reddi → BLOCKED; istek gönderilmez
    h.lanTest = false;
    const n = h.calls.length;
    await expect(chat(h, s, null, "general", [], true)).rejects.toMatchObject({ code: "BLOCKED", detail: "CLEARTEXT_BLOCKED" });
    await expect(chat(h, { ...s, localUrl: "https://ollama.ornek.com/v1" }, null, "general", [], true)).rejects.toMatchObject({ code: "BLOCKED", detail: "TARGET_NOT_ALLOWED" });
    expect(h.calls.length).toBe(n);
    h.next = new Error("HOST_DENIED");
    await expect(chat(h, { ...s, localUrl: "https://10.0.0.5:11434/v1" }, null, "general", [], true)).rejects.toMatchObject({ code: "BLOCKED", detail: "HOST_DENIED" });
    h.next = new Error("REDIRECT_BLOCKED");
    await expect(chat(h, defaultAiSettings(false), "sk", "general", [], false)).rejects.toMatchObject({ code: "BLOCKED", detail: "REDIRECT_BLOCKED" });
    expect(h.calls.at(-1)?.ctx).toEqual({ purpose: "openai", scope: "personal" });
    for (const c of ["HOST_DENIED", "CLEARTEXT_BLOCKED", "TARGET_NOT_ALLOWED", "TARGET_FORBIDDEN", "REDIRECT_BLOCKED", "URL_INVALID", "URL_SCHEME", "PURPOSE_INVALID", "BASKA"]) {
      expect(aiErrorText(new AiError("BLOCKED", c))).toBeTruthy();
    }
    h.lanTest = true;
    h.next = { status: 200, body: "{}" };
    await expect(chat(h, s, null, "general", [], true)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    h.next = { status: 500, body: "x" };
    await expect(chat(h, s, null, "general", [], true)).rejects.toMatchObject({ detail: "HTTP 500" });
    h.next = new Error("x");
    await expect(chat(h, s, null, "general", [], true)).rejects.toMatchObject({ code: "NETWORK" });
    for (const c of ["NO_KEY", "CLOUD_BLOCKED", "NO_LOCAL_URL", "NETWORK", "API_ERROR", "BAD_RESPONSE"] as const) expect(aiErrorText(new AiError(c))).toBeTruthy();
    expect(aiErrorText(new Error("x"))).toBe("Beklenmeyen hata.");
  });
});
