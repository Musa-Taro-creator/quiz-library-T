// Quiz Library — automatic ABA PayWay (KHQR) payments.
//
// Supabase → Edge Functions → Deploy a new function → name it "payway",
// paste this whole file, then turn OFF "Verify JWT" (ABA's callback has no
// login; this file checks the student's login itself).
//
// Secrets (Supabase → Edge Functions → Secrets):
//   ABA_MERCHANT_ID   your PayWay merchant ID
//   ABA_API_KEY       your PayWay API key (keep it secret!)
//   ABA_MODE          "sandbox" while testing, "live" for real money
//   SITE_URL          optional, default https://musa-taro-creator.github.io/quiz-library-T/
//
// Actions (POST JSON { action, ... }):
//   create {plan, period}   make a KHQR for this plan
//   status {tran_id}        ask ABA if it was paid (plan switches on by itself)
//   sync                    re-check this student's recent unpaid QR codes
//   admin_sync              admin: re-check everybody's recent unpaid QR codes
//   admin_ping              admin: is ABA set up correctly?
//   ?callback=1&tran_id=…   ABA calls this when paid (we re-check with ABA)

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const MERCHANT_ID = (Deno.env.get("ABA_MERCHANT_ID") ?? "").trim();
const API_KEY = (Deno.env.get("ABA_API_KEY") ?? "").trim();
const LIVE = (Deno.env.get("ABA_MODE") ?? "sandbox").trim().toLowerCase() === "live";
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://musa-taro-creator.github.io/quiz-library-T/";
const ABA_BASE = LIVE
  ? "https://checkout.payway.com.kh/api/payment-gateway/v1/payments"
  : "https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments";
const QR_MINUTES = 10;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class Friendly extends Error {}

// ---------------------------------------------------------------- helpers
async function hmac(text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(API_KEY),
    { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  let bin = "";
  sig.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
function reqTime(): string {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
const fmtAmount = (v: number, cur: string) => (cur === "KHR" ? String(Math.round(v)) : Number(v).toFixed(2));

async function rpc(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const t = await r.text();
  const data = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Friendly(String(data?.message ?? t));
  return data;
}
async function select(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}
async function userFrom(req: Request): Promise<{ id: string; email?: string } | null> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY || SERVICE_KEY, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ? u : null;
}
async function paymentSettings() {
  const rows = await select("ql_site_settings?key=eq.payment&select=value");
  return (rows?.[0]?.value ?? {}) as Record<string, unknown>;
}

async function aba(endpoint: string, body: Record<string, unknown>) {
  const r = await fetch(`${ABA_BASE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Referer: SITE_URL, Origin: new URL(SITE_URL).origin },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { status: { code: String(r.status), message: t.slice(0, 200) } }; }
}

const ABA_ERRORS: Record<string, string> = {
  "1": "ABA rejected the request (wrong API key or Merchant ID).",
  "6": "ABA has not whitelisted this website yet. Ask ABA to whitelist it.",
  "23": "KHQR payments are not switched on for this ABA merchant account.",
  "429": "ABA is busy. Please try again in a minute.",
};

// Ask ABA about one payment and save the answer.
async function check(tran_id: string) {
  const t = reqTime();
  const res = await aba("check-transaction-2", { req_time: t, merchant_id: MERCHANT_ID, tran_id, hash: await hmac(t + MERCHANT_ID + tran_id) });
  const ok = String(res?.status?.code ?? "") === "00";
  const d = res?.data ?? {};
  const code = ok ? Number(d.payment_status_code) : NaN;
  const state = code === 0 ? "paid" : code === 3 || code === 7 ? "failed" : code === 4 ? "refunded" : "pending";
  const amount = d.total_amount != null ? Number(d.total_amount) : d.payment_amount != null ? Number(d.payment_amount) : null;
  const currency = d.payment_currency ?? d.currency ?? null;
  return await rpc("ql__aba_update", { p_tran_id: tran_id, p_state: state, p_amount: amount, p_currency: currency, p_apv: d.apv ? String(d.apv) : null });
}

// ---------------------------------------------------------------- actions
async function create(user: { id: string; email?: string }, plan: string, period: string) {
  const pay = await paymentSettings();
  if (!pay.aba_enabled) throw new Friendly("Paying with ABA is switched off right now.");
  const currency = String(pay.aba_currency ?? "USD").toUpperCase() === "KHR" ? "KHR" : "USD";
  const row = await rpc("ql__aba_start", { p_uid: user.id, p_plan: plan, p_period: period, p_currency: currency, p_minutes: QR_MINUTES });

  const f: Record<string, string> = {
    req_time: reqTime(),
    merchant_id: MERCHANT_ID,
    tran_id: row.tran_id,
    amount: fmtAmount(Number(row.amount), currency),
    items: b64(JSON.stringify([{ name: `Quiz Library ${row.plan_name} (${period})`.slice(0, 60), quantity: 1, price: Number(row.amount) }])),
    first_name: "",
    last_name: "",
    email: String(row.email ?? "").slice(0, 50),
    phone: "",
    purchase_type: "purchase",
    payment_option: "abapay_khqr",
    callback_url: b64(`${SUPABASE_URL}/functions/v1/payway?callback=1&tran_id=${row.tran_id}`),
    return_deeplink: "",
    currency,
    custom_fields: "",
    return_params: "",
    payout: "",
    lifetime: String(QR_MINUTES),
    qr_image_template: "template3_color",
  };
  const order = ["req_time", "merchant_id", "tran_id", "amount", "items", "first_name", "last_name", "email", "phone", "purchase_type",
    "payment_option", "callback_url", "return_deeplink", "currency", "custom_fields", "return_params", "payout", "lifetime", "qr_image_template"];
  const hash = await hmac(order.map((k) => f[k]).join(""));
  const body: Record<string, unknown> = { ...f, lifetime: QR_MINUTES, hash };
  for (const k of ["first_name", "last_name", "phone", "return_deeplink", "custom_fields", "return_params", "payout"]) if (!f[k]) body[k] = null;

  const res = await aba("generate-qr", body);
  const code = String(res?.status?.code ?? "");
  if (code !== "0" || !(res.qrImage || res.qrString)) {
    await rpc("ql__aba_update", { p_tran_id: row.tran_id, p_state: "failed", p_amount: null, p_currency: null, p_apv: null }).catch(() => {});
    console.error("generate-qr failed", code, res?.status?.message);
    throw new Friendly(ABA_ERRORS[code] ?? `ABA could not make the QR (${code || "no answer"}${res?.status?.message ? ": " + res.status.message : ""}).`);
  }
  return {
    tran_id: row.tran_id, amount: row.amount, currency, expires_at: row.expires_at, plan_name: row.plan_name,
    qr_image: res.qrImage ?? null, qr_string: res.qrString ?? null, deeplink: res.abapay_deeplink ?? null, sandbox: !LIVE,
  };
}

async function syncAll(uid: string | null) {
  const rows = await rpc("ql__aba_open", { p_uid: uid });
  let approved = 0, checked = 0;
  for (const r of rows ?? []) {
    try { const s = await check(r.tran_id); checked++; if (s.status === "approved") approved++; } catch (e) { console.error("check", r.tran_id, e); }
  }
  return { checked, approved };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    // ABA tells us a payment changed. We never trust the message itself —
    // we ask ABA again with our own key before switching anything on.
    if (url.searchParams.get("callback")) {
      let tran = url.searchParams.get("tran_id") ?? "";
      if (!tran && req.method === "POST") {
        const raw = await req.text();
        try { tran = JSON.parse(raw).tran_id ?? ""; } catch { tran = new URLSearchParams(raw).get("tran_id") ?? ""; }
      }
      if (/^[A-Za-z0-9_-]{4,30}$/.test(tran)) { try { await check(tran); } catch (e) { console.error("callback", e); } }
      return json({ status: "ok" });
    }
    if (!MERCHANT_ID || !API_KEY) return json({ error: "ABA is not set up yet (missing ABA_MERCHANT_ID / ABA_API_KEY secrets)." }, 400);

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const user = await userFrom(req);
    if (!user) return json({ error: "Please sign in again." }, 401);
    const action = String(body.action ?? "");

    if (action === "create") {
      if (!["month", "year", "lifetime"].includes(body.period)) throw new Friendly("Choose monthly, yearly or lifetime.");
      return json(await create(user, String(body.plan ?? ""), body.period));
    }
    if (action === "status") {
      const tran = String(body.tran_id ?? "");
      const rows = await select(`ql_payment_requests?tran_id=eq.${encodeURIComponent(tran)}&select=user_id,status,expires_at,admin_note`);
      const row = rows?.[0];
      if (!row || row.user_id !== user.id) return json({ error: "Payment not found." }, 404);
      if (row.status === "approved" || row.status === "rejected") return json({ status: row.status, expires_at: row.expires_at, admin_note: row.admin_note });
      const s = await check(tran);
      return json({ status: s.status, expires_at: s.expires_at, admin_note: s.admin_note });
    }
    if (action === "sync") return json(await syncAll(user.id));
    if (action === "admin_sync" || action === "admin_ping") {
      if (!(await rpc("ql__aba_is_admin", { p_uid: user.id }))) return json({ error: "Admins only." }, 403);
      if (action === "admin_sync") return json(await syncAll(null));
      const t = reqTime(), tran = "QLPING" + Date.now().toString(36).toUpperCase();
      const res = await aba("check-transaction-2", { req_time: t, merchant_id: MERCHANT_ID, tran_id: tran, hash: await hmac(t + MERCHANT_ID + tran) });
      const code = String(res?.status?.code ?? "");
      return json({ mode: LIVE ? "live" : "sandbox", merchant_id: MERCHANT_ID, aba_code: code, aba_message: res?.status?.message ?? "",
                    key_ok: code !== "1" && code !== "" });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof Friendly) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
