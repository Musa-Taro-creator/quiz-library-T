// Quiz Library — "Make Google Form" (Edge Function ql-gform).
//
// The app calls this with the student's login. It:
//   1. lets Supabase check the login (keep "Verify JWT" ON for this function),
//   2. takes one of today's forms in the database (ql_gform_reserve, 5 a day),
//   3. reads the Apps Script address + secret (only this function can, with the service key),
//   4. asks the Apps Script web app (owned by the forms Gmail) to make or change the form,
//   5. saves the result in the student's list.
// The Apps Script address and secret never reach the browser.
//
// Create it in Supabase → Edge Functions → Deploy a new function → name: ql-gform,
// paste this file, keep "Verify JWT" ON. No secrets to add: Supabase gives every function
// SUPABASE_URL and its keys (new SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS, or the legacy
// SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY). It uses the new keys when they are there.
//
// Written without imports or types so the same file is tested in Node (tests/google-forms-edge.test.mjs).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function makeHandler(env, fetchFn) {
  const base = String(env.SUPABASE_URL || "").replace(/\/$/, "");
  // New API keys first (SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS are JSON like
  // {"default":"sb_..."}); the legacy anon / service_role keys (retired by Supabase end of 2026) as fallback.
  const fromJson = (v) => { try { const o = JSON.parse(v || "{}"); return o.default || Object.values(o)[0] || ""; } catch { return ""; } };
  const anon = fromJson(env.SUPABASE_PUBLISHABLE_KEYS) || env.SUPABASE_ANON_KEY || "";
  const publicKeys = [anon, env.SUPABASE_ANON_KEY || ""].filter(Boolean);
  const service = fromJson(env.SUPABASE_SECRET_KEYS) || env.SUPABASE_SERVICE_ROLE_KEY || "";
  const reply = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  async function rpc(name, args, token, key) {
    const headers = { apikey: key, "Content-Type": "application/json" };
    // New sb_ keys are not JWTs: send them only as apikey and Supabase acts with that key's role.
    if (!(token === key && /^sb_/.test(key))) headers.Authorization = `Bearer ${token}`;
    const r = await fetchFn(`${base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args || {}),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      const msg = (data && (data.message || data.error)) || `${name} failed (${r.status})`;
      const e = new Error(String(msg));
      e.status = r.status === 401 ? 401 : 400;
      throw e;
    }
    return data;
  }
  const asUser = (token) => (name, args) => rpc(name, args, token, anon);
  const asServer = (name, args) => rpc(name, args, service, service);

  async function script(cfg, body) {
    if (!cfg || !cfg.script_url) {
      const e = new Error("Make Google Form is not set up yet. Please try again later.");
      e.status = 503;
      throw e;
    }
    let r;
    try {
      // Apps Script answers a POST with a redirect to the result; fetch follows it.
      r = await fetchFn(cfg.script_url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ ...body, secret: cfg.secret }),
        redirect: "follow",
      });
    } catch {
      const e = new Error("Google did not answer. Please try again.");
      e.status = 502;
      throw e;
    }
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      const e = new Error("Google sent an unexpected answer. Is the Apps Script deployed as a Web app for Anyone?");
      e.status = 502;
      throw e;
    }
    if (!data || data.ok !== true) {
      const e = new Error((data && data.error) || "Google could not do it.");
      e.status = data && data.error === "Not allowed" ? 503 : 400;
      if (data && data.error === "Not allowed") e.message = "The Google Forms secret in Admin does not match the Apps Script.";
      throw e;
    }
    return data;
  }

  // Only the text of each question goes to Google (no pictures), with sane sizes.
  function cleanQuestions(list) {
    return (Array.isArray(list) ? list : []).slice(0, 200).map((q) => ({
      type: ["mcq", "true_false", "short_answer"].includes(q && q.type) ? q.type : "mcq",
      prompt: String((q && q.prompt) || "").slice(0, 4000),
      options: Array.isArray(q && q.options) ? q.options.slice(0, 50).map((o) => String(o == null ? "" : o).slice(0, 500)) : [],
      correct: q && typeof q.correct === "boolean" ? q.correct : (Array.isArray(q && q.correct) ? q.correct : [q && q.correct]).map(Number).filter(Number.isFinite).slice(0, 50),
      answers: Array.isArray(q && q.answers) ? q.answers.slice(0, 20).map((a) => String(a).slice(0, 500)) : [],
      multi: !!(q && q.multi),
      points: Number(q && q.points) || 1,
      explanation: String((q && q.explanation) || "").slice(0, 4000),
    }));
  }

  return async function handle(req) {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return reply(405, { ok: false, error: "POST only" });
    const auth = req.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token || publicKeys.includes(token) || /^sb_/.test(token)) return reply(401, { ok: false, error: "Please sign in again." });
    if (!service) return reply(503, { ok: false, error: "The server key is missing for ql-gform." });
    let body;
    try { body = await req.json(); } catch { return reply(400, { ok: false, error: "Bad request" }); }
    const user = asUser(token);
    try {
      switch (body && body.action) {
        case "make": {
          const questions = cleanQuestions(body.questions);
          const title = String(body.title || "").trim().slice(0, 200) || "Quiz";
          const editor = String(body.editor_email || "").trim().toLowerCase().slice(0, 200);
          const res = await user("ql_gform_reserve", { p_title: title, p_question_count: questions.length, p_source: String(body.source || "paste").slice(0, 20) });
          try {
            const cfg = await asServer("ql_gform__owner", { p_owner_email: null });
            const made = await script(cfg, {
              action: "make", user_id: res.user_id, user_label: res.user_label, title,
              description: String(body.description || "").slice(0, 4000), questions, editor_email: editor,
            });
            const row = await asServer("ql_gform__finish", { p_id: res.record_id, p_data: made });
            return reply(200, { ok: true, form: row, left: res.left, limit: res.limit, unlimited: !!res.unlimited, mode: res.mode || "", plan_name: res.plan_name || "", editor_error: made.editor_error || "",
                                no_answer: made.no_answer || 0, short_answers: made.short_answers || 0 });
          } catch (e) {
            await asServer("ql_gform__fail", { p_id: res.record_id, p_error: String(e.message || e) }).catch(() => {});
            throw e;
          }
        }
        case "status": {
          const mine = await user("ql_gform_mine", {});
          const forms = (mine && mine.forms) || [];
          const byOwner = {};
          forms.slice(0, 60).forEach((f) => { if (f.form_id) (byOwner[f.owner_email || ""] ||= []).push(f.form_id); });
          const out = {};
          for (const [owner, ids] of Object.entries(byOwner)) {
            try {
              const cfg = await asServer("ql_gform__owner", { p_owner_email: owner || null });
              Object.assign(out, (await script(cfg, { action: "status", form_ids: ids })).forms || {});
            } catch { /* that Gmail is gone or busy: show the list without numbers */ }
          }
          return reply(200, { ok: true, forms: out });
        }
        case "rename":
        case "accepting":
        case "share": {
          const rec = await user("ql_gform_get", { p_id: body.id });
          if (!rec) return reply(404, { ok: false, error: "That form is not in your list." });
          const cfg = await asServer("ql_gform__owner", { p_owner_email: rec.owner_email || null });
          const done = await script(cfg, {
            action: body.action, user_id: rec.user_id, form_id: rec.form_id,
            title: String(body.title || "").slice(0, 200), accepting: !!body.accepting,
            email: String(body.email || "").trim().toLowerCase(), user_label: "Student",
          });
          const patch = body.action === "rename" ? { title: done.title }
            : body.action === "accepting" ? { accepting: done.accepting }
            : { editor_email: done.editor_email, folder_url: done.folder_url };
          await asServer("ql_gform__update", { p_id: rec.id, p_data: patch });
          return reply(200, { ok: true, ...patch });
        }
        case "ping": {
          await user("ql_gform_admin_check", {});
          const cfg = await asServer("ql_gform__owner", { p_owner_email: null });
          const pong = await script(cfg, { action: "ping" });
          await asServer("ql_gform__checked", { p_script_url: cfg.script_url, p_owner_email: pong.owner });
          return reply(200, { ok: true, owner: pong.owner });
        }
        default:
          return reply(400, { ok: false, error: "Unknown action" });
      }
    } catch (e) {
      return reply(e.status || 400, { ok: false, error: String(e.message || e) });
    }
  };
}

if (typeof Deno !== "undefined") {
  Deno.serve(makeHandler(Deno.env.toObject(), fetch));
}
