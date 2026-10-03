// Quiz Library — sends admin notifications (Web Push).
// The database (supabase/admin_push.sql) calls this when a student sends a
// Help & Support message or a payment receipt. It reads the keys and the admin's
// devices with the built-in service key, so no secret has to be pasted anywhere.
// Create it in Supabase → Edge Functions → name: ql-push, and turn OFF "Verify JWT".
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: cfg } = await sb.from("ql_push_config").select("public_key,private_key,secret").eq("id", 1).maybeSingle();
  // only our own database knows this secret
  if (!cfg || !cfg.secret || req.headers.get("x-ql-push") !== cfg.secret) return new Response("forbidden", { status: 403 });
  let msg: Record<string, unknown> = {};
  try { msg = await req.json(); } catch { /* empty body */ }
  webpush.setVapidDetails("https://musa-taro-creator.github.io/quiz-library-T/", cfg.public_key, cfg.private_key);
  const { data: subs } = await sb.from("ql_push_subs").select("id,endpoint,p256dh,auth");
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 86400 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("ql_push_subs").delete().eq("id", s.id); // device turned it off
    }
  }
  return new Response(JSON.stringify({ sent }), { headers: { "Content-Type": "application/json" } });
});
