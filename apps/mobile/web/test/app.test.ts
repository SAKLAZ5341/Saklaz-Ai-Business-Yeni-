import { describe, expect, it } from "vitest";
import { AiError, aiErrorText, chat, defaultAiSettings, extractResponsesText, MODES } from "../src/ai.js";
import { hostFetch, Store, validateRelay } from "../src/app.js";
import type { Host, HttpResponse } from "../src/host.js";

class MemHost implements Host {
  readonly kind = "android" as const;
  readonly m = new Map<string, string>();
  calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  next: HttpResponse | Error = { status: 200, body: "{}" };
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
  http(url: string, method: string, headers: Record<string, string>, body?: string) {
    this.calls.push({ url, method, headers, ...(body !== undefined ? { body } : {}) });
    return this.next instanceof Error ? Promise.reject(this.next) : Promise.resolve(this.next);
  }
  scanQr() {
    return Promise.resolve(null);
  }
}

describe("relay adresi", () => {
  it("wss zorunlu; ws yalnızca yerel ağ testi işaretliyse", () => {
    expect(validateRelay(" wss://relay.ornek.com/v1/connect ", false)).toBe("wss://relay.ornek.com");
    expect(() => validateRelay("ws://10.0.0.2:8080", false)).toThrow("RELAY_URL_INSECURE");
    expect(validateRelay("ws://10.0.0.2:8080", true)).toBe("ws://10.0.0.2:8080");
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
    const r = await hostFetch(h)("https://x/v1/a", { method: "POST", headers: { a: "b" }, body: "{}" });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ ok: true });
    h.next = { status: 204, body: "" };
    expect(await (await hostFetch(h)("https://x", { method: "GET", headers: {} })).json()).toEqual({});
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
    const s = { ...defaultAiSettings(true), localUrl: "http://10.0.0.5:11434/v1/" };
    h.next = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "Yerel yanıt" } }] }) };
    expect(await chat(h, s, null, "meeting", [{ role: "user", text: "not" }], true)).toBe("Yerel yanıt");
    expect(h.calls[0]?.url).toBe("http://10.0.0.5:11434/v1/chat/completions");
    expect(h.calls[0]?.headers["authorization"]).toBeUndefined();
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
