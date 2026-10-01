// Quiz Library — check student payments against your ABA Telegram group.
//
// A spare Telegram account (a normal member of the group where "PayWay by
// ABA" posts your payments) is used to read those messages. When a student
// types the transaction number from their receipt, it is matched with ABA's
// message and the plan switches on by itself.
//
// Supabase → Edge Functions → Deploy a new function → name it "abacheck",
// paste this whole file → Deploy.
// Secrets (Supabase → Edge Functions → Secrets), from my.telegram.org with the
// SPARE account → API development tools:
//   TG_API_ID     e.g. 1234567
//   TG_API_HASH   e.g. 0123456789abcdef0123456789abcdef
// Then connect the account in admin → Settings → ABA Telegram check.

import { Api, TelegramClient } from "npm:telegram@2.26.22";
import { StringSession } from "npm:telegram@2.26.22/sessions/index.js";
import { computeCheck } from "npm:telegram@2.26.22/Password.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const API_ID = Number(Deno.env.get("TG_API_ID") ?? 0);
const API_HASH = (Deno.env.get("TG_API_HASH") ?? "").trim();
const SYNC_EVERY_MS = 12000; // read Telegram at most every 12 seconds

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class Friendly extends Error {}

// ---------------------------------------------------------------- reading ABA's messages
// Khmer:   ៛44,500 ត្រូវបានបង់ដោយ THON SOKLOR (*568) នៅថ្ងៃទី 9 ... លេខប្រតិបត្តិការ: 177828808648912។ APV: 133067។
// English: $4.00 paid by THON SOKLOR (*568) on May 09, 2026 ... Trx. ID: 177828808648912. APV: 133067.
const KH_DIGITS = "០១២៣៤៥៦៧៨៩";
const toLatin = (s: string) => s.replace(/[០-៩]/g, (d) => String(KH_DIGITS.indexOf(d)));
export function parseAba(text: string) {
  const t = toLatin(text || "");
  const trx = t.match(/(?:លេខប្រតិបត្តិការ|Trx\.?\s*ID|Transaction\s*(?:ID|No\.?|number)|Ref(?:erence)?\.?\s*(?:ID|No\.?)?)\s*[:：]?\s*([0-9]{6,})/i);
  if (!trx) return null;
  let m = t.match(/(៛|\$|USD|KHR|Riel)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  let cur = "", amt = "";
  if (m) { cur = m[1]; amt = m[2]; }
  else {
    m = t.match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*(៛|\$|USD|KHR|Riel)/i);
    if (m) { amt = m[1]; cur = m[2]; }
  }
  if (!amt) return null;
  const currency = /^(៛|KHR|Riel)$/i.test(cur) ? "KHR" : "USD";
  const amount = Number(amt.replace(/,/g, ""));
  if (!(amount > 0)) return null;
  const payer = (t.match(/(?:បង់ដោយ|paid by|from)\s+(.+?)\s*\(/i) || [])[1] ?? null;
  const apv = (t.match(/APV\s*[:：]?\s*([0-9]+)/i) || [])[1] ?? null;
  return { trx_id: trx[1], amount, currency, payer: payer ? payer.slice(0, 80) : null, apv };
}

// ---------------------------------------------------------------- database
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
async function rest(path: string, method = "GET", body?: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
type Sess = { session: string | null; phone: string | null; code_hash: string | null; chat_id: string | null; chat_title: string | null; last_sync: string | null };
const getSess = async (): Promise<Sess> => (await rest("ql_tg_session?id=eq.1&select=*"))?.[0] ?? {};
const setSess = (patch: Record<string, unknown>) => rest("ql_tg_session?id=eq.1", "PATCH", { ...patch, updated_at: new Date().toISOString() });

async function userFrom(req: Request): Promise<{ id: string } | null> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY || SERVICE_KEY, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ? u : null;
}

// ---------------------------------------------------------------- telegram
function client(session: string | null) {
  if (!API_ID || !API_HASH) throw new Friendly("Telegram is not set up yet (missing TG_API_ID / TG_API_HASH secrets).");
  const c = new TelegramClient(new StringSession(session ?? ""), API_ID, API_HASH, { connectionRetries: 2, deviceModel: "Quiz Library", appVersion: "1.0" });
  c.setLogLevel("error" as never);
  return c;
}
async function closeClient(c: TelegramClient) { try { await c.destroy(); } catch { /* ignore */ } }
const tgErr = (e: unknown) => String((e as { errorMessage?: string })?.errorMessage ?? (e as Error)?.message ?? e);
const LOGGED_OUT = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED|SESSION_EXPIRED/;

async function findChat(c: TelegramClient, chatId: string) {
  const dialogs = await c.getDialogs({ limit: 300 });
  return dialogs.find((d) => String(d.id) === chatId) ?? null;
}

// Read the newest ABA messages and save them. Returns how many were new.
async function syncTelegram(force = false): Promise<{ added: number; read: number; skipped?: boolean }> {
  const s = await getSess();
  if (!s.session || s.code_hash) throw new Friendly("The Telegram account is not connected yet.");
  if (!s.chat_id) throw new Friendly("Choose your ABA group first (admin → Settings).");
  if (!force && s.last_sync && Date.now() - new Date(s.last_sync).getTime() < SYNC_EVERY_MS) return { added: 0, read: 0, skipped: true };
  await setSess({ last_sync: new Date().toISOString() });
  const c = client(s.session);
  try {
    await c.connect();
    const d = await findChat(c, s.chat_id);
    if (!d) throw new Friendly("The Telegram account can't see your ABA group any more. Add it to the group again.");
    const msgs = await c.getMessages(d.inputEntity, { limit: 120 });
    const rows = [];
    for (const m of msgs) {
      const p = parseAba(m.message ?? "");
      if (p) rows.push({ ...p, paid_at: new Date((m.date ?? 0) * 1000).toISOString(), raw: (m.message ?? "").slice(0, 600), msg_id: m.id });
    }
    const added = rows.length ? await rpc("ql__tg_store", { p_rows: rows }) : 0;
    await setSess({ last_error: null });
    return { added, read: rows.length };
  } catch (e) {
    const msg = tgErr(e);
    if (LOGGED_OUT.test(msg)) await setSess({ session: null, account: null, last_error: "Telegram logged this account out. Connect it again." });
    else await setSess({ last_error: msg.slice(0, 300) });
    if (e instanceof Friendly) throw e;
    throw new Friendly(LOGGED_OUT.test(msg) ? "Telegram logged the account out. Connect it again in admin." : "Could not read Telegram right now: " + msg);
  } finally {
    await closeClient(c);
  }
}

async function matchAll(uid: string | null) {
  const rows = await rpc("ql__tg_waiting", { p_uid: uid });
  let approved = 0;
  for (const r of rows ?? []) if ((await rpc("ql__tg_match", { p_payment: r.id })) === "approved") approved++;
  return approved;
}

// ---------------------------------------------------------------- admin: connect the spare account
async function loginStart(phone: string) {
  phone = phone.replace(/[^\d+]/g, "");
  if (phone.length < 8) throw new Friendly("Type the phone number with country code, e.g. +855 12 345 678.");
  const c = client(null);
  try {
    await c.connect();
    const r = await c.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
    await setSess({ session: c.session.save() as unknown as string, phone, code_hash: r.phoneCodeHash, account: null, last_error: null });
    return { sent: true, via_app: r.isCodeViaApp };
  } catch (e) {
    throw new Friendly("Telegram did not send a code: " + tgErr(e));
  } finally {
    await closeClient(c);
  }
}
async function loginCode(code: string, password: string) {
  const s = await getSess();
  if (!s.session || !s.code_hash) throw new Friendly("Press 'Send code' first.");
  const c = client(s.session);
  try {
    await c.connect();
    if (s.code_hash !== "__password__") {
      try {
        await c.invoke(new Api.auth.SignIn({ phoneNumber: s.phone ?? "", phoneCodeHash: s.code_hash, phoneCode: code.replace(/\D/g, "") }));
      } catch (e) {
        if (tgErr(e) !== "SESSION_PASSWORD_NEEDED") throw e;
        await setSess({ session: c.session.save() as unknown as string, code_hash: "__password__" });
        if (!password) return { need_password: true };
      }
    }
    if ((await getSess()).code_hash === "__password__") {
      if (!password) return { need_password: true };
      const pw = await c.invoke(new Api.account.GetPassword());
      await c.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pw, password) }));
    }
    const me = await c.getMe() as Api.User;
    const name = [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "Telegram account";
    await setSess({ session: c.session.save() as unknown as string, code_hash: null, account: name, last_error: null });
    return { connected: true, account: name };
  } catch (e) {
    const m = tgErr(e);
    throw new Friendly(m === "PHONE_CODE_INVALID" ? "That code is wrong." : m === "PHONE_CODE_EXPIRED" ? "The code expired. Press 'Send code' again." :
      m === "PASSWORD_HASH_INVALID" ? "Wrong Telegram password (2-step verification)." : "Could not sign in: " + m);
  } finally {
    await closeClient(c);
  }
}
async function listChats() {
  const s = await getSess();
  if (!s.session || s.code_hash) throw new Friendly("Connect the Telegram account first.");
  const c = client(s.session);
  try {
    await c.connect();
    const dialogs = await c.getDialogs({ limit: 200 });
    return dialogs.filter((d) => d.isGroup || d.isChannel).map((d) => ({
      id: String(d.id), title: d.title ?? "Group", aba: /PayWay|ABA|លេខប្រតិបត្តិការ|APV/i.test(d.message?.message ?? "") || /ABA|PayWay/i.test(d.title ?? ""),
    }));
  } finally {
    await closeClient(c);
  }
}

// ---------------------------------------------------------------- requests
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const user = await userFrom(req);
    if (!user) return json({ error: "Please sign in again." }, 401);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    // Student: "I paid" → check this payment now
    if (action === "verify") {
      const rows = await rest(`ql_payment_requests?id=eq.${encodeURIComponent(String(body.payment_id ?? ""))}&select=user_id,status`);
      if (!rows?.[0] || rows[0].user_id !== user.id) return json({ error: "Payment not found." }, 404);
      if (rows[0].status !== "waiting") return json({ status: rows[0].status === "approved" ? "approved" : "handled" });
      let note = "";
      try { await syncTelegram(); } catch (e) { note = e instanceof Friendly ? e.message : ""; }
      const status = await rpc("ql__tg_match", { p_payment: body.payment_id });
      return json({ status, note });
    }
    // Student: re-check my waiting payments (app opened)
    if (action === "mine") {
      try { await syncTelegram(); } catch { /* admin sees the error */ }
      return json({ approved: await matchAll(user.id) });
    }

    if (!(await rpc("ql__tg_is_admin", { p_uid: user.id }))) return json({ error: "Admins only." }, 403);
    if (action === "login_start") return json(await loginStart(String(body.phone ?? "")));
    if (action === "login_code") return json(await loginCode(String(body.code ?? ""), String(body.password ?? "")));
    if (action === "chats") return json({ chats: await listChats() });
    if (action === "set_chat") {
      await setSess({ chat_id: String(body.chat_id ?? ""), chat_title: String(body.title ?? "").slice(0, 120), last_sync: null });
      const r = await syncTelegram(true);
      return json({ ...r, approved: await matchAll(null) });
    }
    if (action === "sync") {
      const r = await syncTelegram(true);
      return json({ ...r, approved: await matchAll(null) });
    }
    if (action === "logout") {
      const s = await getSess();
      if (s.session && !s.code_hash) { const c = client(s.session); try { await c.connect(); await c.invoke(new Api.auth.LogOut()); } catch { /* ignore */ } finally { await closeClient(c); } }
      await setSess({ session: null, code_hash: null, account: null, phone: null, last_error: null });
      return json({ ok: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof Friendly) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
