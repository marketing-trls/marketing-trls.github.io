/* Tara Rose planner helper (Cloudflare Worker).
   1. Shared plan: the website reads the plan from here and saves every edit here, so everyone sees the same posts.
   2. Captions: writes captions with Claude. The Anthropic API key is a secret on Cloudflare, never in the website.
   Saving and captions only work for people signed in to the website with a @tararosesalon.com Google account.
   Setup: Workers & Pages → Create → Worker → paste this file → Deploy.
   Then in the worker: Settings → Variables and Secrets → Secret ANTHROPIC_API_KEY,
   and Bindings → KV namespace → variable name PLAN (create a namespace called tara-rose-plan). */
const ALLOWED_ORIGIN = "https://marketing-trls.github.io";
const GOOGLE_CLIENT_ID = "993280924669-ru49psdbgb2s7cb9u044fpbi28s320fs.apps.googleusercontent.com";
const ALLOWED_DOMAIN = "tararosesalon.com";
const MODEL = "claude-sonnet-5-5";
const COLLS = { posts: "post:", campaigns: "camp:" };

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Vary": "Origin"
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && path === "/plan") {
      if (!env.PLAN) return json({ error: "no_store" }, 500);
      return json(await readPlan(env.PLAN));
    }
    if (req.method !== "POST") return json({ ok: true, service: "Tara Rose planner helper", store: !!env.PLAN, captions: !!env.ANTHROPIC_API_KEY });

    // Who is asking? Check the Google sign-in from the website.
    const who = await signedIn(req);
    if (who.error) return json({ error: who.error }, who.status);

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

    if (path === "/save") {
      if (!env.PLAN) return json({ error: "no_store" }, 500);
      const ops = Array.isArray(body.ops) ? body.ops.slice(0, 50) : [];
      const saved = { posts: {}, campaigns: {}, settings: null };
      for (const o of ops) {
        if (o.coll === "settings") {
          const cur = JSON.parse((await env.PLAN.get("settings")) || "{}");
          const doc = { ...cur, ...(o.data || {}), updatedBy: who.email };
          await env.PLAN.put("settings", JSON.stringify(doc)); saved.settings = doc; continue;
        }
        const prefix = COLLS[o.coll], id = String(o.id || "");
        if (!prefix || !/^[\w.:@+~-]{1,200}$/.test(id)) continue;
        if (o.op === "delete") { const t = { __deleted: true }; await env.PLAN.put(prefix + id, JSON.stringify(t)); saved[o.coll][id] = t; continue; }
        const cur = JSON.parse((await env.PLAN.get(prefix + id)) || "{}");
        const doc = { ...(cur.__deleted ? {} : cur), ...(o.data || {}), updatedBy: who.email };
        delete doc.__deleted;
        await env.PLAN.put(prefix + id, JSON.stringify(doc)); saved[o.coll][id] = doc;
      }
      return json({ ok: true, saved });
    }

    if (path === "/" || path === "/captions") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "no_key" }, 500);
      const prompt = String(body.prompt || "");
      if (!prompt || prompt.length > 60000) return json({ error: "bad_request" }, 400);
      const content = (Array.isArray(body.images) ? body.images.slice(0, 1) : [])
        .filter(i => i && typeof i.data === "string" && /^image\/(jpeg|png|webp|gif)$/.test(i.media_type || ""))
        .map(i => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } }));
      content.push({ type: "text", text: prompt });
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: "user", content }] })
      });
      if (r.status === 429) return json({ error: "rate_limited" }, 429);
      if (!r.ok) return json({ error: "upstream", status: r.status }, 502);
      const out = await r.json();
      return json({ text: (out.content || []).filter(c => c.type === "text").map(c => c.text).join("\n") });
    }
    return json({ error: "not_found" }, 404);
  }
};

async function signedIn(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: "signin", status: 401 };
  const info = await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(token))
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!info) return { error: "signin", status: 401 };
  const email = String(info.email || "").toLowerCase();
  if (info.aud !== GOOGLE_CLIENT_ID || String(info.email_verified) !== "true" || !email.endsWith("@" + ALLOWED_DOMAIN)) return { error: "forbidden", status: 403 };
  return { email };
}

async function readPlan(kv) {
  const plan = { posts: {}, campaigns: {}, settings: JSON.parse((await kv.get("settings")) || "null") };
  for (const [coll, prefix] of Object.entries(COLLS)) {
    let cursor;
    do {
      const page = await kv.list({ prefix, cursor });
      const vals = await Promise.all(page.keys.map(k => kv.get(k.name)));
      page.keys.forEach((k, i) => { if (vals[i]) plan[coll][k.name.slice(prefix.length)] = JSON.parse(vals[i]); });
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }
  return plan;
}
