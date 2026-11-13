/**
 * SAKLAZ AI mobil arayüzü (MVP alfa). Çerçevesiz DOM; bütün durum app.ts'dedir.
 */
import { RelayApiError } from "@saklaz/client-core";
import { aiErrorText, chat, defaultAiSettings, MODES, type AiMode, type AiSettings, type ChatTurn } from "./ai.js";
import { createProfile, registerAccount, Session, Store, type NoteItem, type ProfileMeta, type TodoItem } from "./app.js";
import { detectHost, type Host } from "./host.js";

type Tab = "devices" | "command" | "ai" | "notes" | "settings";

const host: Host = detectHost();
const store = new Store(host);
let session: Session | undefined;
let tab: Tab = "devices";
let selected: string | undefined;
let aiMode: AiMode = "general";
let chatHistory: ChatTurn[] = [];
let aiBusy = false;

// ---- küçük DOM yardımcıları --------------------------------------------------------------------
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false || v === null) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = (v as string);
    else if (k === "value") (el as HTMLInputElement).value = (v as string);
    else if (k === "checked") (el as HTMLInputElement).checked = !!v;
    else el.setAttribute(k, v === true ? "" : (v as string));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
const $ = (id: string) => document.getElementById(id);
const val = (id: string) => ($(id) as HTMLInputElement | null)?.value ?? "";
function toast(text: string): void {
  const t = h("div", { class: "toast" }, text);
  document.body.append(t);
  setTimeout(() => {
    t.remove();
  }, 3500);
}
function errText(e: unknown): string {
  if (e instanceof RelayApiError) {
    const m: Record<string, string> = {
      INVALID_CREDENTIALS: "E-posta, parola veya doğrulama kodu hatalı.",
      LOCKED: "Çok fazla hatalı deneme. Hesap geçici olarak kilitli.",
      EMAIL_TAKEN: "Bu e-posta ile hesap zaten var. Giriş yapın.",
      WEAK_PASSWORD: "Parola en az 12 karakter olmalı.",
      NETWORK: "Relay sunucusuna ulaşılamadı.",
      RATE_LIMITED: "Çok fazla istek. Biraz bekleyin.",
    };
    return m[e.code] ?? `Relay hatası: ${e.code}`;
  }
  const msg = e instanceof Error ? e.message : String(e);
  const m: Record<string, string> = {
    RELAY_URL_INVALID: "Relay adresi geçersiz (wss://… olmalı).",
    RELAY_URL_INSECURE: "ws:// yalnızca 'yerel ağ testi' işaretliyse kullanılabilir.",
    QR_INVALID: "Eşleştirme kodu geçersiz.",
    QR_EXPIRED: "Eşleştirme kodunun süresi dolmuş. Bilgisayarda yeniden başlatın.",
    ALREADY_PAIRED: "Bu bilgisayar zaten ekli.",
  };
  return m[msg] ?? msg;
}

// ---- iskelet ----------------------------------------------------------------------------------
function frame(content: Node, withNav: boolean): void {
  const app = $("app");
  if (!app) return;
  const parts: (Node | null)[] = [
    host.kind === "dev-insecure" ? h("div", { class: "banner" }, "GELİŞTİRME KİPİ: anahtarlar tarayıcı deposunda, şifresiz. Gerçek kullanım için Android uygulamasını kullanın.") : null,
    h(
      "header",
      {},
      h("h1", {}, "SAKLAZ AI"),
      session ? h("span", { class: `chip ${session.meta.kind}` }, `${session.meta.kind === "business" ? "Kurumsal" : "Kişisel"} · ${session.meta.name}`) : null,
      session ? h("span", { id: "relaydot", class: `dot ${relayDot()}`, title: "Relay bağlantısı" }) : null,
    ),
    h("main", { id: "main" }, content),
    withNav
      ? h(
          "nav",
          {},
          ...(
            [
              ["devices", "Cihazlar"],
              ["command", "Komut"],
              ["ai", "AI"],
              ["notes", "Not/Görev"],
              ["settings", "Ayarlar"],
            ] as [Tab, string][]
          ).map(([t, l]) =>
            h(
              "button",
              {
                class: tab === t ? "active" : "",
                onclick: () => {
                  tab = t;
                  void render();
                },
              },
              l,
            ),
          ),
        )
      : null,
  ];
  app.replaceChildren(...parts.filter((x): x is Node => x !== null));
}
function relayDot(): string {
  if (!session) return "";
  return session.relayState === "ready" ? "on" : session.relayState === "connecting" ? "wait" : "off";
}

/** Oturum olaylarında yalnızca canlı bölgeler yenilenir (yazılan metin kaybolmaz). */
function onSessionChange(): void {
  const d = $("relaydot");
  if (d) d.className = `dot ${relayDot()}`;
  const live = $("live");
  if (live && session) live.replaceChildren(...liveContent());
}
function liveContent(): Node[] {
  if (!session) return [];
  if (tab === "devices") return [devicesList(), pairingPanel()];
  if (tab === "command") return [tasksList()];
  return [];
}

// ---- profil oluşturma / giriş -----------------------------------------------------------------
function onboarding(): void {
  let mode: "login" | "register" = "login";
  const form = () =>
    h(
      "div",
      {},
      h("h2", {}, "Çalışma alanı ekle"),
      h(
        "div",
        { class: "card" },
        h("p", { class: "muted" }, "Kişisel ve kurumsal alanlar tamamen ayrıdır: ayrı relay, ayrı hesap, ayrı anahtarlar."),
        h("label", {}, "Alan türü"),
        h("select", { id: "kind" }, h("option", { value: "personal" }, "Kişisel"), h("option", { value: "business" }, "Kurumsal")),
        h("label", {}, "Görünen ad"),
        h("input", { id: "pname", placeholder: "ör. Ev, Şirket" }),
        h("label", {}, "Relay adresi"),
        h("input", { id: "relay", placeholder: "wss://relay.ornek.com", autocapitalize: "off", autocomplete: "off" }),
        h("label", { class: "row" }, h("input", { id: "insecure", type: "checkbox" }), h("span", {}, "Yerel ağ testi (ws://, TLS yok — yalnızca test)")),
        h(
          "div",
          { class: "tabs2", style: "margin-top:12px" },
          h(
            "button",
            {
              class: mode === "login" ? "active" : "",
              onclick: () => {
                mode = "login";
                redraw();
              },
            },
            "Giriş",
          ),
          h(
            "button",
            {
              class: mode === "register" ? "active" : "",
              onclick: () => {
                mode = "register";
                redraw();
              },
            },
            "Yeni hesap",
          ),
        ),
        h("label", {}, "E-posta"),
        h("input", { id: "email", type: "email", autocomplete: "username" }),
        h("label", {}, "Parola (en az 12 karakter)"),
        h("input", { id: "pw", type: "password", autocomplete: mode === "login" ? "current-password" : "new-password" }),
        mode === "login" ? h("label", {}, "Doğrulama uygulamasındaki 6 haneli kod") : null,
        mode === "login" ? h("input", { id: "code", inputmode: "numeric", maxlength: "6" }) : null,
        h("div", { id: "obmsg" }),
        h(
          "div",
          { class: "btns" },
          h("button", { class: "btn", id: "obgo", onclick: () => void submit() }, mode === "login" ? "Giriş yap ve alanı oluştur" : "Hesap oluştur"),
          session ? h("button", { class: "btn secondary", onclick: () => ((tab = "settings"), void render()) }, "Vazgeç") : null,
        ),
      ),
    );
  const keep = () => ({ kind: val("kind"), pname: val("pname"), relay: val("relay"), email: val("email"), insecure: ($("insecure") as HTMLInputElement | null)?.checked ?? false });
  const redraw = () => {
    const k = keep();
    frame(form(), !!session);
    ($("kind") as HTMLSelectElement).value = k.kind || "personal";
    ($("pname") as HTMLInputElement).value = k.pname;
    ($("relay") as HTMLInputElement).value = k.relay;
    ($("email") as HTMLInputElement).value = k.email;
    ($("insecure") as HTMLInputElement).checked = k.insecure;
  };
  const submit = async () => {
    const msg = $("obmsg");
    const btn = $("obgo") as HTMLButtonElement;
    btn.disabled = true;
    try {
      const insecure = ($("insecure") as HTMLInputElement).checked;
      if (mode === "register") {
        const otp = await registerAccount(host, val("relay"), insecure, val("email"), val("pw"));
        const secret = new URL(otp).searchParams.get("secret") ?? "";
        msg?.replaceChildren(
          h(
            "div",
            { class: "card" },
            h("b", {}, "Hesap oluşturuldu. İki adımlı doğrulamayı kurun:"),
            h("p", { class: "muted" }, "Google Authenticator / Microsoft Authenticator'a bu anahtarı ekleyin, sonra 'Giriş' sekmesinden 6 haneli kodla giriş yapın. Anahtar bir daha gösterilmez."),
            h("pre", {}, secret.replace(/(.{4})/g, "$1 ").trim()),
            h("a", { href: otp }, "Doğrulama uygulamasında aç"),
          ),
        );
        return;
      }
      const meta = await createProfile(store, {
        name: val("pname"),
        kind: val("kind") === "business" ? "business" : "personal",
        relayUrl: val("relay"),
        insecure,
        email: val("email"),
        password: val("pw"),
        code: val("code"),
      });
      await activate(meta);
    } catch (e) {
      msg?.replaceChildren(h("p", { class: "bad" }, errText(e)));
    } finally {
      btn.disabled = false;
    }
  };
  frame(form(), !!session);
}

async function activate(meta: ProfileMeta): Promise<void> {
  session?.close();
  session = undefined;
  chatHistory = [];
  selected = undefined;
  await host.set("active", meta.id);
  session = await Session.open(store, meta, onSessionChange);
  chatHistory = await store.pget<ChatTurn[]>(meta.id, "chat", []);
  tab = "devices";
  await render();
}

// ---- Cihazlar ----------------------------------------------------------------------------------
function devicesList(): Node {
  if (!session) return h("div");
  const list = session.computers();
  if (!list.length) return h("div", { class: "card muted" }, "Henüz bilgisayar yok. Bilgisayarda 'saklaz-agent pair' çalıştırın ve aşağıdan ekleyin.");
  return h(
    "div",
    {},
    ...list.map((c) => {
      const p = session?.presence.get(c.deviceId);
      return h(
        "div",
        { class: "card row" },
        h("span", { class: `dot ${p ? (p.online ? "on" : "off") : ""}` }),
        h(
          "div",
          { class: "grow" },
          h("b", {}, c.label),
          h("div", { class: "muted" }, p ? (p.online ? "Çevrimiçi" : `Çevrimdışı${p.lastSeen ? ` · son: ${new Date(p.lastSeen).toLocaleString("tr-TR")}` : ""}`) : "Durum bilinmiyor", ` · rol: ${c.role ?? "—"}`),
        ),
        h(
          "button",
          {
            class: "btn secondary",
            onclick: () => {
              selected = c.deviceId;
              tab = "command";
              void render();
            },
          },
          "Komut",
        ),
      );
    }),
  );
}

function pairingPanel(): Node {
  if (!session) return h("div");
  const p = session.pairing;
  if (p && !p.done && !p.error)
    return h(
      "div",
      { class: "card" },
      h("b", {}, `“${p.label}” ekleniyor`),
      h("p", { class: "muted" }, "Bilgisayar ekranındaki güvenlik kodu bununla AYNI ise bilgisayarda 'e' ile onaylayın. Farklıysa onaylamayın."),
      h("div", { class: "sas" }, p.sas),
      h("p", { class: "muted" }, "Bilgisayardan onay bekleniyor…"),
    );
  if (p?.done) return h("div", { class: "card ok" }, `“${p.label}” eklendi.`);
  return h(
    "div",
    { class: "card" },
    h("h2", {}, "Bilgisayar ekle"),
    p?.error ? h("p", { class: "bad" }, `Eşleştirme başarısız (${p.error}). Bilgisayarda yeniden başlatın.`) : null,
    h("label", {}, "Bilgisayarın adı"),
    h("input", { id: "plabel", placeholder: "ör. Şirket bilgisayarı" }),
    h("label", {}, "Eşleştirme kodu (QR okutun veya yapıştırın)"),
    h("textarea", { id: "pcode", placeholder: "SAKLAZ1:…", autocapitalize: "off" }),
    h(
      "div",
      { class: "btns" },
      h(
        "button",
        {
          class: "btn secondary",
          onclick: async () => {
            try {
              const t = await host.scanQr();
              if (t) ($("pcode") as HTMLTextAreaElement).value = t;
              else toast("QR okunamadı; kodu yapıştırın.");
            } catch {
              toast("Kamera kullanılamadı; kodu yapıştırın.");
            }
          },
        },
        "QR okut",
      ),
      h(
        "button",
        {
          class: "btn",
          onclick: async () => {
            try {
              await session?.startPairing(val("pcode"), val("plabel") || "Bilgisayar");
            } catch (e) {
              toast(errText(e));
            }
          },
        },
        "Eşleştir",
      ),
    ),
  );
}

// ---- Komut -------------------------------------------------------------------------------------
const QUICK = ["sistem", "disk", "ağ", "işlemler", "çalışma süresi", "ping", "yardım"];
function commandTab(): Node {
  if (!session) return h("div");
  const list = session.computers();
  if (!list.length) return h("div", { class: "card muted" }, "Önce bir bilgisayar ekleyin.");
  if (!selected || !list.some((c) => c.deviceId === selected)) selected = list[0]?.deviceId;
  const send = async (text: string) => {
    if (!text.trim() || !selected) return;
    try {
      await session?.sendCommand(selected, text);
      const i = $("cmdtext") as HTMLInputElement | null;
      if (i) i.value = "";
    } catch (e) {
      toast(errText(e));
    }
  };
  return h(
    "div",
    {},
    h(
      "div",
      { class: "card" },
      h("label", {}, "Bilgisayar"),
      h(
        "select",
        {
          id: "target",
          onchange: (e: Event) => {
            selected = (e.target as HTMLSelectElement).value;
            onSessionChange();
          },
        },
        ...list.map((c) => h("option", { value: c.deviceId, selected: c.deviceId === selected }, c.label)),
      ),
      h("p", { class: "muted" }, "Bu sürümde yalnızca salt okunur, izinli komutlar çalışır. Diğer her şey bilgisayarda reddedilir."),
      h("div", { class: "quick" }, ...QUICK.map((q) => h("button", { onclick: () => void send(q) }, q))),
      h("div", { class: "row" }, h("input", { id: "cmdtext", class: "grow", placeholder: "Komut yazın", onkeydown: (e: KeyboardEvent) => e.key === "Enter" && void send(val("cmdtext")) }), h("button", { class: "btn", onclick: () => void send(val("cmdtext")) }, "Gönder")),
    ),
    h("div", { id: "live" }, ...liveContent()),
  );
}

function tasksList(): Node {
  if (!session) return h("div");
  const label = (id: string) => session?.computers().find((c) => c.deviceId === id)?.label ?? "silinmiş cihaz";
  const st: Record<string, string> = { sent: "gönderildi", received: "alındı", running: "çalışıyor", succeeded: "tamamlandı", failed: "başarısız", rejected: "reddedildi" };
  const items = session.tasks.filter((t) => !selected || t.deviceId === selected).slice(-30).reverse();
  if (!items.length) return h("div", { class: "muted" }, "Henüz komut yok.");
  return h(
    "div",
    {},
    ...items.map((t) =>
      h(
        "div",
        { class: "card" },
        h("div", { class: "row" }, h("b", { class: "grow" }, t.text), h("span", { class: `chip ${t.status === "succeeded" ? "ok" : t.status === "failed" ? "bad" : ""}` }, st[t.status] ?? t.status)),
        h("div", { class: "muted" }, `${label(t.deviceId)} · ${new Date(t.ts).toLocaleTimeString("tr-TR")}`),
        t.summary ? h("pre", {}, t.summary) : null,
      ),
    ),
  );
}

// ---- AI ----------------------------------------------------------------------------------------
async function aiSettings(): Promise<AiSettings> {
  if (!session) return defaultAiSettings(false);
  return store.pget<AiSettings>(session.meta.id, "ai", defaultAiSettings(session.meta.kind === "business"));
}
function aiTab(s: AiSettings): Node {
  const meta = session?.meta;
  if (!meta) return h("div");
  const cloudBlocked = meta.kind === "business" && s.provider === "openai" && !s.allowCloud;
  const box = h("div", { id: "chatbox" }, ...chatHistory.map((t) => h("div", { class: `msg ${t.role}` }, t.text)));
  const ask = async () => {
    const text = val("aitext").trim();
    if (!text || aiBusy) return;
    aiBusy = true;
    chatHistory.push({ role: "user", text });
    ($("aitext") as HTMLTextAreaElement).value = "";
    box.append(h("div", { class: "msg user" }, text));
    const wait = h("div", { class: "msg assistant muted" }, "…");
    box.append(wait);
    try {
      const key = await store.secret(meta.id, "aikey");
      const answer = await chat(host, s, key, aiMode, chatHistory, meta.kind === "business");
      chatHistory.push({ role: "assistant", text: answer });
      wait.className = "msg assistant";
      wait.textContent = answer;
      await store.pput(meta.id, "chat", chatHistory.slice(-60));
    } catch (e) {
      chatHistory.pop();
      wait.className = "msg assistant bad";
      wait.textContent = aiErrorText(e);
    } finally {
      aiBusy = false;
    }
  };
  return h(
    "div",
    {},
    h(
      "div",
      { class: "tabs2" },
      ...(Object.keys(MODES) as AiMode[]).map((m) =>
        h(
          "button",
          {
            class: m === aiMode ? "active" : "",
            onclick: () => {
              aiMode = m;
              void render();
            },
          },
          MODES[m].label,
        ),
      ),
    ),
    h("div", { class: "muted" }, `Sağlayıcı: ${s.provider === "openai" ? `OpenAI (${s.model})` : `Yerel (${s.localUrl || "adres yok"})`}${cloudBlocked ? " — kurumsal alanda bulut kapalı" : ""}`),
    h("p", { class: "muted" }, "AI bilgisayarlara komut gönderemez; yalnızca metin üretir."),
    box,
    h("textarea", { id: "aitext", placeholder: "Mesajınız" }),
    h(
      "div",
      { class: "btns" },
      h("button", { class: "btn", onclick: () => void ask() }, "Gönder"),
      h(
        "button",
        {
          class: "btn secondary",
          onclick: async () => {
            chatHistory = [];
            await store.pput(meta.id, "chat", []);
            void render();
          },
        },
        "Sohbeti temizle",
      ),
      h("button", { class: "btn secondary", disabled: true, title: "Bu sürümde yok" }, "🎤 Sesli (yakında)"),
    ),
  );
}

// ---- Not / Görev -------------------------------------------------------------------------------
async function notesTab(): Promise<Node> {
  const meta = session?.meta;
  if (!meta) return h("div");
  const notes = await store.pget<NoteItem[]>(meta.id, "notes", []);
  const todos = await store.pget<TodoItem[]>(meta.id, "todos", []);
  const save = async () => {
    await store.pput(meta.id, "notes", notes);
    await store.pput(meta.id, "todos", todos);
    void render();
  };
  return h(
    "div",
    {},
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Görevler"),
      ...todos.map((t) =>
        h(
          "div",
          { class: "item" },
          h("input", {
            type: "checkbox",
            checked: t.done,
            onchange: () => {
              t.done = !t.done;
              void save();
            },
          }),
          h("div", { class: `grow ${t.done ? "done" : ""}` }, t.text, t.due ? h("div", { class: "muted" }, t.due) : null),
          h(
            "button",
            {
              class: "btn secondary",
              onclick: () => {
                todos.splice(todos.indexOf(t), 1);
                void save();
              },
            },
            "Sil",
          ),
        ),
      ),
      h("div", { class: "row", style: "margin-top:8px" }, h("input", { id: "todo", class: "grow", placeholder: "Yeni görev" }), h("input", { id: "due", type: "date", style: "width:150px" })),
      h(
        "div",
        { class: "btns" },
        h(
          "button",
          {
            class: "btn",
            onclick: () => {
              const text = val("todo").trim();
              if (!text) return;
              todos.push({ id: crypto.randomUUID(), text: text.slice(0, 500), done: false, ...(val("due") ? { due: val("due") } : {}) });
              void save();
            },
          },
          "Ekle",
        ),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Notlar"),
      h("textarea", { id: "note", placeholder: "Not" }),
      h(
        "div",
        { class: "btns" },
        h(
          "button",
          {
            class: "btn",
            onclick: () => {
              const text = val("note").trim();
              if (!text) return;
              notes.unshift({ id: crypto.randomUUID(), text: text.slice(0, 10_000), ts: Date.now() });
              void save();
            },
          },
          "Kaydet",
        ),
      ),
      ...notes.map((n) =>
        h(
          "div",
          { class: "item" },
          h("div", { class: "grow" }, h("div", { style: "white-space:pre-wrap" }, n.text), h("div", { class: "muted" }, new Date(n.ts).toLocaleString("tr-TR"))),
          h(
            "button",
            {
              class: "btn secondary",
              onclick: () => {
                notes.splice(notes.indexOf(n), 1);
                void save();
              },
            },
            "Sil",
          ),
        ),
      ),
      h("p", { class: "muted" }, "Notlar ve görevler yalnızca bu telefonda, bu alanın şifreli deposunda tutulur."),
    ),
  );
}

// ---- Ayarlar -----------------------------------------------------------------------------------
async function settingsTab(): Promise<Node> {
  const meta = session?.meta;
  if (!meta || !session) return h("div");
  const profiles = await store.profiles();
  const s = await aiSettings();
  const hasKey = !!(await store.secret(meta.id, "aikey"));
  const comps = session.computers();
  return h(
    "div",
    {},
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Çalışma alanları"),
      ...profiles.map((p) =>
        h(
          "div",
          { class: "item" },
          h("span", { class: `chip ${p.kind}` }, p.kind === "business" ? "Kurumsal" : "Kişisel"),
          h("div", { class: "grow" }, h("b", {}, p.name), h("div", { class: "muted" }, `${p.relayUrl} · ${p.email}`)),
          p.id === meta.id ? h("span", { class: "muted" }, "etkin") : h("button", { class: "btn secondary", onclick: () => void activate(p) }, "Geç"),
        ),
      ),
      h("div", { class: "btns" }, h("button", { class: "btn secondary", onclick: () => onboarding() }, "Alan ekle")),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Yapay zekâ"),
      h("label", {}, "Sağlayıcı"),
      h("select", { id: "aiprov", value: s.provider }, h("option", { value: "openai", selected: s.provider === "openai" }, "OpenAI (bulut)"), h("option", { value: "local", selected: s.provider === "local" }, "Yerel (OpenAI uyumlu, ör. Ollama)")),
      h("label", {}, "Model"),
      h("input", { id: "aimodel", value: s.model }),
      h("label", {}, `OpenAI API anahtarı ${hasKey ? "(kayıtlı — değiştirmek için yazın)" : ""}`),
      h("input", { id: "aikey", type: "password", placeholder: hasKey ? "••••••••" : "sk-…", autocomplete: "off" }),
      h("label", {}, "Yerel AI adresi"),
      h("input", { id: "ailocal", value: s.localUrl, placeholder: "http://192.168.1.10:11434/v1" }),
      meta.kind === "business"
        ? h("label", { class: "row" }, h("input", { id: "aicloud", type: "checkbox", checked: s.allowCloud }), h("span", { class: "warn" }, "Bu kurumsal alanda bulut AI'ya izin ver (yazdığım metinler OpenAI'ya gider)"))
        : null,
      h(
        "div",
        { class: "btns" },
        h(
          "button",
          {
            class: "btn",
            onclick: async () => {
              const next: AiSettings = {
                provider: val("aiprov") === "local" ? "local" : "openai",
                model: val("aimodel").trim() || s.model,
                localUrl: val("ailocal").trim(),
                allowCloud: meta.kind === "business" ? (($("aicloud") as HTMLInputElement | null)?.checked ?? false) : true,
              };
              await store.pput(meta.id, "ai", next);
              const k = val("aikey").trim();
              if (k) await store.setSecret(meta.id, "aikey", k);
              toast("Kaydedildi.");
              void render();
            },
          },
          "Kaydet",
        ),
        hasKey
          ? h(
              "button",
              {
                class: "btn danger",
                onclick: async () => {
                  await host.remove(`p:${meta.id}:aikey`);
                  void render();
                },
              },
              "Anahtarı sil",
            )
          : null,
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Bilgisayarlar — güvenlik"),
      comps.length ? null : h("p", { class: "muted" }, "Bilgisayar yok."),
      ...comps.map((c) =>
        h(
          "div",
          { class: "item" },
          h("div", { class: "grow" }, h("b", {}, c.label)),
          h(
            "button",
            {
              class: "btn danger",
              onclick: async () => {
                if (!confirm(`${c.label}: acil kilit gönderilsin mi? Bilgisayar yalnızca kendisinde yerel olarak açılabilir.`)) return;
                await session?.lockdown(c.deviceId);
                toast("Acil kilit gönderildi.");
              },
            },
            "Acil kilit",
          ),
          h(
            "button",
            {
              class: "btn danger",
              onclick: async () => {
                if (!confirm(`${c.label} kalıcı olarak çıkarılsın mı? Yeniden eklemek için yeni eşleştirme gerekir.`)) return;
                await session?.revoke(c.deviceId);
                void render();
              },
            },
            "Çıkar",
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Bu alan"),
      h("p", { class: "muted" }, `Telefon kimliği: ${session.phone.id}`),
      h(
        "button",
        {
          class: "btn danger",
          onclick: async () => {
            if (!confirm("Bu alan bu telefondan silinsin mi? Anahtarlar silinir; bilgisayarlar yeniden eşleştirilmelidir.")) return;
            session?.close();
            session = undefined;
            await store.deleteProfile(meta.id);
            await boot();
          },
        },
        "Alanı bu telefondan sil",
      ),
    ),
    h("p", { class: "muted" }, "SAKLAZ AI 0.1.0-alpha · test sürümü"),
  );
}

// ---- çizim ve açılış ---------------------------------------------------------------------------
async function render(): Promise<void> {
  if (!session) {
    onboarding();
    return;
  }
  let content: Node;
  switch (tab) {
    case "devices":
      content = h("div", {}, h("h2", {}, "Bilgisayarlar"), h("div", { id: "live" }, ...liveContent()));
      break;
    case "command":
      content = commandTab();
      break;
    case "ai":
      content = aiTab(await aiSettings());
      break;
    case "notes":
      content = await notesTab();
      break;
    case "settings":
      content = await settingsTab();
      break;
  }
  frame(content, true);
}

async function boot(): Promise<void> {
  const profiles = await store.profiles();
  const activeId = await host.get("active");
  const meta = profiles.find((p) => p.id === activeId) ?? profiles[0];
  if (!meta) {
    onboarding();
    return;
  }
  try {
    await activate(meta);
  } catch (e) {
    frame(h("div", { class: "card bad" }, `Alan açılamadı: ${errText(e)}`), false);
  }
}

void boot();
