/**
 * Yapay zekâ sağlayıcıları (MVP alfa).
 *   • openai — OpenAI Responses API; anahtar kullanıcı tarafından girilir ve yalnızca güvenli depoda tutulur.
 *   • local  — OpenAI uyumlu yerel sunucu (ör. Ollama: http://bilgisayar:11434/v1); veri ağdan çıkmaz.
 * Anahtar veya bağlantı yoksa SAHTE yanıt üretilmez; açık bir hata gösterilir.
 * AI komut GÖNDEREMEZ: yalnızca metin üretir. Bilgisayara komut her zaman kullanıcı tarafından gönderilir.
 */
import type { Host } from "./host.js";
import { isPolicyCode, validateLocalAiUrl } from "./netpolicy.js";

export type AiProvider = "openai" | "local";

export interface AiSettings {
  provider: AiProvider;
  model: string;
  localUrl: string;
  /** Kurumsal profilde bulut AI varsayılan olarak KAPALIDIR; kullanıcı açıkça izin vermelidir. */
  allowCloud: boolean;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export const MODES = {
  general: { label: "Kişisel asistan", prompt: "Sen SAKLAZ AI kişisel asistanısın. Türkçe, kısa ve net yanıt ver." },
  plan: { label: "Günlük plan", prompt: "Kullanıcının verdiği görev ve randevulardan saat saat gerçekçi bir günlük plan çıkar. Öncelikleri belirt. Türkçe yanıt ver." },
  meeting: { label: "Toplantı", prompt: "Toplantı notlarından kararlar, sorumlular ve tarihlerle eylem listesi çıkar; gündem önerisi istenirse hazırla. Türkçe yanıt ver." },
  purchase: { label: "Satınalma", prompt: "Satınalma asistanısın: ihtiyaç tanımı, teklif karşılaştırma tablosu, tedarikçiye soru listesi ve onay notu hazırla. Fiyat uydurma; bilinmeyeni açıkça belirt. Türkçe yanıt ver." },
} as const;
export type AiMode = keyof typeof MODES;

export class AiError extends Error {
  constructor(readonly code: "NO_KEY" | "CLOUD_BLOCKED" | "NETWORK" | "API_ERROR" | "BAD_RESPONSE" | "NO_LOCAL_URL" | "BLOCKED", readonly detail = "") {
    super(code);
    this.name = "AiError";
  }
}

export function defaultAiSettings(business: boolean): AiSettings {
  return { provider: business ? "local" : "openai", model: business ? "llama3.1" : "gpt-5.4-mini", localUrl: "", allowCloud: !business };
}

function messages(mode: AiMode, history: ChatTurn[]) {
  return [{ role: "system", content: MODES[mode].prompt }, ...history.slice(-20).map((t) => ({ role: t.role, content: t.text }))];
}

/** Kabuk isteği reddederse (politika/onay) BLOCKED; diğer hatalar NETWORK. */
function hostError(e: unknown): AiError {
  const code = e instanceof Error ? e.message : "";
  return isPolicyCode(code) ? new AiError("BLOCKED", code) : new AiError("NETWORK");
}

export async function chat(host: Host, s: AiSettings, apiKey: string | null, mode: AiMode, history: ChatTurn[], business: boolean): Promise<string> {
  const scope = business ? "business" : "personal";
  if (s.provider === "openai") {
    if (business && !s.allowCloud) throw new AiError("CLOUD_BLOCKED");
    if (!apiKey) throw new AiError("NO_KEY");
    let r;
    try {
      r = await host.http(
        "https://api.openai.com/v1/responses",
        "POST",
        { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        JSON.stringify({ model: s.model, instructions: MODES[mode].prompt, input: history.slice(-20).map((t) => ({ role: t.role, content: t.text })), store: false }),
        { purpose: "openai", scope },
      );
    } catch (e) {
      throw hostError(e);
    }
    if (r.status >= 400) throw new AiError("API_ERROR", apiErrorMessage(r.body, r.status));
    return extractResponsesText(r.body);
  }
  if (!s.localUrl) throw new AiError("NO_LOCAL_URL");
  let base: string;
  try {
    base = validateLocalAiUrl(s.localUrl, (await host.info()).lanTest);
  } catch (e) {
    throw new AiError("BLOCKED", e instanceof Error ? e.message : "URL_INVALID");
  }
  let r;
  try {
    r = await host.http(`${base}/chat/completions`, "POST", { "content-type": "application/json" }, JSON.stringify({ model: s.model, messages: messages(mode, history), stream: false }), {
      purpose: "local-ai",
      scope,
    });
  } catch (e) {
    throw hostError(e);
  }
  if (r.status >= 400) throw new AiError("API_ERROR", apiErrorMessage(r.body, r.status));
  try {
    const o = JSON.parse(r.body) as { choices?: { message?: { content?: string } }[] };
    const t = o.choices?.[0]?.message?.content;
    if (typeof t === "string" && t) return t;
  } catch {
    /* aşağıda */
  }
  throw new AiError("BAD_RESPONSE");
}

export function extractResponsesText(body: string): string {
  try {
    const o = JSON.parse(body) as { output_text?: string; output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
    if (typeof o.output_text === "string" && o.output_text) return o.output_text;
    const parts: string[] = [];
    for (const item of o.output ?? []) for (const c of item.content ?? []) if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    if (parts.length) return parts.join("\n");
  } catch {
    /* aşağıda */
  }
  throw new AiError("BAD_RESPONSE");
}

function apiErrorMessage(body: string, status: number): string {
  try {
    const o = JSON.parse(body) as { error?: { message?: string } | string };
    const m = typeof o.error === "string" ? o.error : o.error?.message;
    if (m) return `${String(status)}: ${m.slice(0, 200)}`;
  } catch {
    /* gövde JSON değil */
  }
  return `HTTP ${String(status)}`;
}

export function aiErrorText(e: unknown): string {
  if (!(e instanceof AiError)) return "Beklenmeyen hata.";
  switch (e.code) {
    case "NO_KEY":
      return "OpenAI API anahtarı girilmemiş. Ayarlar → Yapay zekâ bölümünden ekleyin veya yerel AI'ya geçin.";
    case "CLOUD_BLOCKED":
      return "Kurumsal profilde bulut AI kapalı (şirket verisi dışarı gönderilmez). Yerel AI kullanın veya ayarlardan açıkça izin verin.";
    case "NO_LOCAL_URL":
      return "Yerel AI adresi girilmemiş (ör. http://192.168.1.10:11434/v1).";
    case "NETWORK":
      return "AI sunucusuna ulaşılamadı. İnternet/yerel ağ bağlantısını kontrol edin.";
    case "API_ERROR":
      return `AI sunucusu hata döndürdü (${e.detail}).`;
    case "BAD_RESPONSE":
      return "AI yanıtı okunamadı.";
    case "BLOCKED":
      return policyText(e.detail);
  }
}

export function policyText(code: string): string {
  const m: Record<string, string> = {
    HOST_DENIED: "Bu sunucuya gönderime izin vermediniz. (Ayarlar → Ağ izinlerini sıfırla ile yeniden sorulur.)",
    CLEARTEXT_BLOCKED: "Şifresiz (http) bağlantı bu yapıda kapalı. https kullanın; http yalnızca yerel ağ test yapısında ve yalnızca yerel ağ adreslerine.",
    TARGET_NOT_ALLOWED: "Bu adrese bu amaçla gönderim izinli değil. Yerel AI yalnızca yerel ağ adresleri (192.168.x.x, 10.x.x.x, 172.16–31.x.x) olabilir.",
    TARGET_FORBIDDEN: "Bu adres hiçbir amaçla kullanılamaz.",
    REDIRECT_BLOCKED: "Sunucu yönlendirme döndürdü; güvenlik nedeniyle izlenmedi.",
    URL_INVALID: "Adres geçersiz.",
    URL_SCHEME: "Adres https:// (veya test yapısında http://) ile başlamalı.",
    PURPOSE_INVALID: "Geçersiz istek.",
  };
  return m[code] ?? `İstek engellendi (${code}).`;
}
