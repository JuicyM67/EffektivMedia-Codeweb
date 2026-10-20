// GET /api/arende/typer — the request types for the "Vad gäller det?" choice.
// Cached for 10 minutes (in memory and at Vercel's edge): every call with the
// website key counts against a limit shared by all visitors.

const { inkio, send } = require("../_lib/inkio");

const CACHE_MS = 10 * 60 * 1000;
let cache = { at: 0, list: null };

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { ok: false, error: "Method not allowed" });
  }

  if (!cache.list || Date.now() - cache.at > CACHE_MS) {
    try {
      const response = await inkio("get-request-types", { key: true });
      if (!response.ok) {
        console.error("Inkio get-request-types: HTTP", response.status);
        return send(res, 502, { ok: false, types: [] });
      }
      const types = await response.json();
      cache = {
        at: Date.now(),
        list: (Array.isArray(types) ? types : []).map((t) => ({
          id: String(t.id),
          title: String(t.title || ""),
          hint: t.description_hint ? String(t.description_hint) : "",
        })),
      };
    } catch (err) {
      console.error("Inkio get-request-types failed:", err.message);
      return send(res, 502, { ok: false, types: [] });
    }
  }

  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=600, stale-while-revalidate=600");
  return res.status(200).json({ ok: true, types: cache.list });
};
