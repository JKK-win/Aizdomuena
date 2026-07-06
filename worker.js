/**
 * Aizdomu Ēnā — Cloudflare Worker starpnieks.
 * API atslēgas glabājas TIKAI šeit (Worker vidē), ne spēles lapā.
 *
 * Uzstādīšana (dash.cloudflare.com):
 *   Workers & Pages → Create → Worker → ielīmē šo kodu → Deploy.
 *   Pēc tam Worker → Settings → Variables and Secrets → pievieno 3 SECRET tipa mainīgos:
 *     ANTHROPIC_KEY  = tava Anthropic atslēga (sk-ant-...)
 *     ELEVEN_KEY     = tava ElevenLabs atslēga (sk_...)
 *     GAME_PASS      = tevis izdomāta spēles parole (piem. ligo2026)
 *
 * Maršruti (visiem vajag pareizu paroli galvenē x-game-pass):
 *   POST /claude        → api.anthropic.com/v1/messages
 *   POST /stt           → ElevenLabs speech-to-text (multipart)
 *   POST /tts?voice=ID  → ElevenLabs text-to-speech (atgriež mp3)
 *   GET  /voices        → ElevenLabs balsu saraksts
 */

const ALLOWED_ORIGIN = "https://jkk-win.github.io";
const MAX_TOKENS = 1024;      // griesti vienai atbildei
const MAX_TEXT_CHARS = 3000;  // griesti TTS tekstam

function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-game-pass",
    "Access-Control-Max-Age": "86400",
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...cors, "content-type": "application/json" },
  });
}
function passThrough(upstream, cors) {
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...cors,
      "content-type": upstream.headers.get("content-type") || "application/octet-stream",
    },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    /* Ne-API pieprasījumi (pati spēles lapa, attēli) → statiskie faili no repo */
    const isApi = ["/claude", "/stt", "/tts", "/voices"].includes(url.pathname);
    if (!isApi) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: "Nezināms maršruts: " + url.pathname }, 404, cors);
    }

    const pass = request.headers.get("x-game-pass") || url.searchParams.get("p") || "";
    if (!env.GAME_PASS || pass !== env.GAME_PASS) {
      return json({ error: "Nepareiza vai trūkstoša spēles parole." }, 403, cors);
    }

    try {
      /* ---- AI modelis (Gemini vai Claude — pēc modeļa nosaukuma) ---- */
      if (url.pathname === "/claude" && request.method === "POST") {
        const body = await request.json();
        const model = String(body.model || "gemini-2.5-flash");

        if (model.startsWith("gemini")) {
          if (!env.GEMINI_KEY) return json({ error: "Serverī nav GEMINI_KEY." }, 500, cors);
          const gbody = {
            system_instruction: { parts: [{ text: String(body.system || "") }] },
            contents: (body.messages || []).map((m) => ({
              role: m.role === "assistant" ? "model" : "user",
              parts: [{ text: String(m.content || "") }],
            })),
            generationConfig: Object.assign(
              { maxOutputTokens: 2048 },
              model.includes("flash") ? { thinkingConfig: { thinkingBudget: 0 } } : {}
            ),
          };
          const r = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/" + model +
              ":generateContent?key=" + env.GEMINI_KEY,
            { method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify(gbody) }
          );
          if (!r.ok) return passThrough(r, cors);
          const d = await r.json();
          const text = ((((d.candidates || [])[0] || {}).content || {}).parts || [])
            .map((p) => p.text || "").join("");
          /* atbilde Anthropic formātā, lai spēles kods nemainās */
          return json({ content: [{ type: "text", text }] }, 200, cors);
        }

        if (!env.ANTHROPIC_KEY) return json({ error: "Serverī nav ANTHROPIC_KEY." }, 500, cors);
        body.max_tokens = Math.min(body.max_tokens || MAX_TOKENS, MAX_TOKENS);
        delete body.stream; // straumēšanu neatbalstām
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        return passThrough(r, cors);
      }

      /* ---- Runa → teksts ---- */
      if (url.pathname === "/stt" && request.method === "POST") {
        const inForm = await request.formData();
        const outForm = new FormData();
        const file = inForm.get("file");
        if (!file) return json({ error: "Trūkst audio faila." }, 400, cors);
        outForm.append("file", file, file.name || "audio.webm");
        outForm.append("model_id", "scribe_v1");
        outForm.append("language_code", inForm.get("language_code") || "lv");
        const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
          method: "POST",
          headers: { "xi-api-key": env.ELEVEN_KEY },
          body: outForm,
        });
        return passThrough(r, cors);
      }

      /* ---- Teksts → runa ---- */
      if (url.pathname === "/tts" && request.method === "POST") {
        const voice = url.searchParams.get("voice");
        if (!voice || !/^[A-Za-z0-9]+$/.test(voice)) return json({ error: "Nederīgs voice ID." }, 400, cors);
        const body = await request.json();
        const text = String(body.text || "").slice(0, MAX_TEXT_CHARS);
        const r = await fetch(
          "https://api.elevenlabs.io/v1/text-to-speech/" + voice + "?output_format=mp3_44100_128",
          {
            method: "POST",
            headers: { "xi-api-key": env.ELEVEN_KEY, "content-type": "application/json" },
            body: JSON.stringify({ text, model_id: body.model_id || "eleven_v3" }),
          }
        );
        return passThrough(r, cors);
      }

      /* ---- Balsu saraksts ---- */
      if (url.pathname === "/voices" && request.method === "GET") {
        const r = await fetch("https://api.elevenlabs.io/v1/voices?show_legacy=true", {
          headers: { "xi-api-key": env.ELEVEN_KEY },
        });
        return passThrough(r, cors);
      }

      return json({ error: "Nezināms API maršruts: " + url.pathname }, 404, cors);
    } catch (e) {
      return json({ error: "Worker kļūda: " + e.message }, 500, cors);
    }
  },
};
