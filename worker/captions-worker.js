/* Tara Rose captions helper (Cloudflare Worker).
   Keeps the Anthropic API key as a secret on Cloudflare, never in the website.
   Only people signed in to the planner website with a @tararosesalon.com Google account can use it.
   Setup: Workers & Pages → Create → Worker → paste this file → Deploy,
   then Settings → Variables and Secrets → add a Secret named ANTHROPIC_API_KEY. */
const ALLOWED_ORIGIN = "https://marketing-trls.github.io";
const GOOGLE_CLIENT_ID = "993280924669-ru49psdbgb2s7cb9u044fpbi28s320fs.apps.googleusercontent.com";
const ALLOWED_DOMAIN = "tararosesalon.com";
const MODEL = "claude-sonnet-5-5";

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin"
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ ok: true, service: "Tara Rose captions helper" });
    if (!env.ANTHROPIC_API_KEY) return json({ error: "no_key" }, 500);

    // Who is asking? Check the Google sign-in from the website.
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "signin" }, 401);
    const info = await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(token))
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (!info) return json({ error: "signin" }, 401);
    const email = String(info.email || "").toLowerCase();
    if (info.aud !== GOOGLE_CLIENT_ID || String(info.email_verified) !== "true" || !email.endsWith("@" + ALLOWED_DOMAIN)) return json({ error: "forbidden" }, 403);

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
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
};
