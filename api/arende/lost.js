// POST /api/arende/lost — "Mitt problem är löst" on the ticket page.

const { inkio, inkioError, send, isSameOrigin, tokenFrom } = require("../_lib/inkio");

const FALLBACK = "Ärendet kunde inte markeras som löst just nu. Försök igen om en stund.";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, error: "Method not allowed" });
  }
  if (!isSameOrigin(req)) {
    return send(res, 403, { ok: false, error: "Ogiltig förfrågan." });
  }
  const token = tokenFrom(req);
  if (!token) {
    return send(res, 404, { ok: false, error: "Vi hittar inte ärendet. Kontrollera länken i ditt mejl." });
  }

  let response;
  try {
    response = await inkio("mark-solved", { json: { token } });
  } catch (err) {
    console.error("Inkio mark-solved failed:", err.name);
    return send(res, 504, { ok: false, error: FALLBACK });
  }

  // 204 on success. 422 means it is no longer open: the page reloads and shows it as it stands.
  if (response.ok || response.status === 422) return send(res, 200, { ok: true });

  const { status, error } = await inkioError(response, FALLBACK);
  if (status !== 404) console.error("Inkio mark-solved: HTTP", response.status);
  return send(res, status, { ok: false, error });
};
