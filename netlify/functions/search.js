// Netlify Function: POST /api/search   body: { query, mode }
// Environment variables (Netlify > Site settings > Environment variables):
//   GEMINI_API_KEY  (required)      GEMINI_MODEL  (optional, default below)
const MODELS = [
  process.env.GEMINI_MODEL || "gemini-3.5-flash",
  ...(process.env.GEMINI_FALLBACK_MODELS || "gemini-3.1-flash-lite,gemini-2.5-flash-lite").split(",")
].map((s) => s.trim()).filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);
const ENDPOINT = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
const BUDGET_MS = 24000; // stop before Netlify's own limit (your log shows 30 s) so the browser gets a clear message, not a platform timeout

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const systemPrompt = (exact) => `You are a careful quotation researcher. ${
  exact ? "The user names a specific book, author, film or series. Return real quotations from that exact work only."
        : "The user describes a feeling or idea. Return real quotations whose meaning matches it."}
Rules: never invent or paraphrase a quotation; every quotation must be verbatim and attributable; for films and series give the character name as author and the title with year as work; prefer short quotations; return at most ${exact ? 5 : 4}.
Reply with ONLY a JSON array, no markdown and no commentary. Each item: {"quote":"","author":"","work":"","why":"one short sentence","sourceUrl":"page URL or empty string"}.`;

function parseJsonArray(text) {
  const clean = String(text || "").replace(/```json|```/gi, "").trim();
  const a = clean.indexOf("["), b = clean.lastIndexOf("]");
  if (a < 0 || b <= a) throw new Error("Model returned no JSON list");
  return JSON.parse(clean.slice(a, b + 1));
}

async function callGemini({ key, model, system, query, grounded, signal }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: query }] }],       // the user's text is never pasted into the system prompt
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 } // 400 was too small: it cut the JSON off mid-way
  };
  if (grounded) body.tools = [{ google_search: {} }];              // real web search (cannot be combined with responseMimeType JSON)
  else body.generationConfig.responseMimeType = "application/json";

  const res = await fetch(ENDPOINT(model), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key }, // key in a header, not in the URL
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  const links = (cand?.groundingMetadata?.groundingChunks || []).map((c) => c?.web?.uri).filter((u) => typeof u === "string" && u.startsWith("http"));
  return { text, links, blocked: data?.promptFeedback?.blockReason || cand?.finishReason };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let query, mode;
  try { ({ query, mode } = JSON.parse(event.body || "{}")); } catch { return json(400, { error: "Invalid request" }); }
  query = String(query || "").trim().slice(0, 300);
  if (!query) return json(400, { error: "Empty query" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(500, { error: "GEMINI_API_KEY is not set for this site. Add it in Netlify > Site settings > Environment variables, then redeploy." });

  const exact = mode === "movie" || mode === "book";
    const system = systemPrompt(exact);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), BUDGET_MS);
  const started = Date.now();
  let out = null, usedModel = "", grounded = false, lastErr = null, sawQuota = false;

  try {
    outer: for (const model of MODELS) {
      for (const g of [true, false]) {
        if (Date.now() - started > BUDGET_MS - 3000) break outer;
        try {
          out = await callGemini({ key, model, system, query, grounded: g, signal: ctl.signal });
          usedModel = model; grounded = g;
          break outer;
        } catch (e) {
          lastErr = e;
          console.error(`${model} ${g ? "grounded" : "plain"} failed:`, e.message);
          if (e.name === "AbortError" || e.status === 401 || e.status === 403) break outer;
          if (e.status === 429) sawQuota = true;
          if (e.status === 404) break;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (!out) {
    const s = lastErr && lastErr.status;
    const timedOut = lastErr && lastErr.name === "AbortError";
    const error = timedOut ? "The search took too long. Please try again, or use a more specific title."
      : (s === 401 || s === 403) ? "Google rejected the API key. Check that the key is valid and the Gemini API is enabled for its project."
      : sawQuota ? "Google says this API key has used up its quota for now. Try again later, or enable billing on the Google project."
      : "The search service returned an error.";
    return json(timedOut ? 504 : sawQuota ? 429 : 502, { error, detail: String(lastErr ? lastErr.message : "no attempt made").slice(0, 300) });
  }

  let items;
  try { items = parseJsonArray(out.text); }
  catch (e) {
    console.error("Unreadable model output:", e.message, "| finish:", out.blocked, "| raw:", String(out.text).slice(0, 500));
    return json(502, { error: "The search returned an unreadable answer. Please try again.", detail: `${e.message} (finish: ${out.blocked || "n/a"})` });
  }

  const results = (Array.isArray(items) ? items : [])
    .filter((x) => x && typeof x.quote === "string" && x.quote.trim())
    .slice(0, 6)
    .map((c, i) => {
      const own = typeof c.sourceUrl === "string" && /^https?:\/\//.test(c.sourceUrl) ? c.sourceUrl : null;
      const url = own || out.links[i] || out.links[0] || null;
      return {
        id: `ei-${Date.now()}-${i}`,
        quote: c.quote.trim(),
        author: String(c.author || "Unknown").slice(0, 120),
        work: String(c.work || "Unknown work").slice(0, 160),
        why: String(c.why || "Matched by live web search.").slice(0, 300),
        sourceUrl: url,
        provenance: url && grounded ? "SOURCE_IDENTIFIED" : "UNVERIFIED",
        matchType: exact ? "EXACT" : "THEMATIC"
      };
    });

  return json(200, { data: results, grounded, model: usedModel });
};
