// Quiz Library — sends admin notifications (Web Push).
// The database (supabase/admin_push.sql) calls this when a student sends a
// Help & Support message or a payment receipt, with a secret only the database knows.
// The function asks the database for the keys + devices with that secret
// (ql_push_payload), so no service key or pasted secret is needed.
// Create it in Supabase → Edge Functions → name: ql-push, and turn OFF "Verify JWT".
import webpush from "npm:web-push@3.6.7";

const URL_ = Deno.env.get("SUPABASE_URL") || "https://hcultemyohiljypthtyb.supabase.co";
const KEY = "sb_publishable_MLyLNla9gaM3r8EUM00hYg_Gyejrvbd"; // public key, same one the website uses

async function rpc(name: string, args: unknown) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: KEY, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${name}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const secret = req.headers.get("x-ql-push") || "";
  let cfg;
  try { cfg = await rpc("ql_push_payload", { p_secret: secret }); }
  catch (e) { return new Response(`config error: ${(e as Error).message}`, { status: 500 }); }
  if (!cfg) return new Response("forbidden", { status: 403 });
  let msg: Record<string, unknown> = {};
  try { msg = await req.json(); } catch { /* empty */ }
  webpush.setVapidDetails("https://musa-taro-creator.github.io/quiz-library-T/", cfg.public_key, cfg.private_key);
  let sent = 0;
  const gone: string[] = [], errors: string[] = [];
  for (const s of cfg.subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 86400, urgency: "high" }); // high = Android delivers it at once, even in battery saver
      sent++;
    } catch (e) {
      const err = e as { statusCode?: number; body?: string; message?: string };
      if (err.statusCode === 404 || err.statusCode === 410) gone.push(s.endpoint);
      else errors.push(`${err.statusCode ?? ""} ${err.body ?? err.message ?? ""}`.slice(0, 200));
    }
  }
  if (gone.length) { try { await rpc("ql_push_gone", { p_secret: secret, p_endpoints: gone }); } catch { /* ignore */ } }
  return new Response(JSON.stringify({ sent, gone: gone.length, errors }), { headers: { "Content-Type": "application/json" } });
});
