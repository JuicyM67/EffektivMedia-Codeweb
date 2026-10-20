// POST /api/arende/svara — the customer's reply from the ticket page.
// Multipart body (message + files named "files") is forwarded to Inkio with
// the token, taken from the X-Arende-Token header, added as a field.

const {
  inkio,
  inkioError,
  send,
  isSameOrigin,
  createLimiter,
  tokenFrom,
  readRawBody,
  multipartBoundary,
  prependField,
} = require("../_lib/inkio");

const MAX_BODY = 4.5 * 1024 * 1024;
const limited = createLimiter(20, 10 * 60 * 1000);
const FALLBACK = "Ditt svar kunde inte skickas just nu. Försök igen om en stund.";

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
  const contentType = req.headers["content-type"];
  const boundary = multipartBoundary(contentType);
  if (!boundary) {
    return send(res, 415, { ok: false, error: "Ogiltig data." });
  }
  if (limited(req)) {
    return send(res, 429, { ok: false, error: "Du har skickat många svar på kort tid. Vänta några minuter och försök igen." });
  }

  let body;
  try {
    body = await readRawBody(req, MAX_BODY);
  } catch (err) {
    if (err.code === "TOO_LARGE") {
      return send(res, 413, { ok: false, error: "Filerna är för stora. Bifoga högst 4 MB totalt." });
    }
    return send(res, 400, { ok: false, error: "Ogiltig data." });
  }

  let response;
  try {
    response = await inkio("reply", {
      multipart: { body: prependField(body, boundary, "token", token), contentType },
    });
  } catch (err) {
    console.error("Inkio reply failed:", err.name);
    return send(res, 504, { ok: false, error: "Det tog för lång tid att få svar. Ladda om sidan och se om ditt svar kom fram." });
  }

  if (response.ok) return send(res, 200, { ok: true });

  const { status, error } = await inkioError(response, FALLBACK);
  if (status !== 422 && status !== 404) console.error("Inkio reply: HTTP", response.status);
  return send(res, status, { ok: false, error });
};
