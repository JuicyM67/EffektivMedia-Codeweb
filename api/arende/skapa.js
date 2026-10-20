// POST /api/arende/skapa — raises a ticket in Inkio from the form on /arende.
// The browser posts multipart/form-data (fields + files named "files"); the
// body is forwarded to Inkio untouched, so every file part keeps its name.

const {
  inkio,
  inkioError,
  send,
  isSameOrigin,
  createLimiter,
  readRawBody,
  multipartBoundary,
} = require("../_lib/inkio");

// Vercel refuses request bodies over 4.5 MB before the function runs.
const MAX_BODY = 4.5 * 1024 * 1024;
const limited = createLimiter(5, 10 * 60 * 1000); // 5 tickets per visitor per 10 minutes
const FALLBACK = "Något gick fel när ärendet skulle skapas. Försök igen om en stund eller mejla hej@effektivmedia.nu.";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, error: "Method not allowed" });
  }
  if (!isSameOrigin(req)) {
    return send(res, 403, { ok: false, error: "Ogiltig förfrågan." });
  }
  const contentType = req.headers["content-type"];
  if (!multipartBoundary(contentType)) {
    return send(res, 415, { ok: false, error: "Ogiltig data." });
  }
  if (limited(req)) {
    return send(res, 429, { ok: false, error: "Du har skickat flera ärenden på kort tid. Vänta några minuter och försök igen." });
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
    response = await inkio("create-ticket", { key: true, multipart: { body, contentType } });
  } catch (err) {
    if (err.code === "CONFIG") {
      console.error(err.message);
      return send(res, 500, { ok: false, error: FALLBACK });
    }
    // Never retry create-ticket on a timeout: the ticket may already exist.
    console.error("Inkio create-ticket failed:", err.name);
    return send(res, 504, {
      ok: false,
      error: "Det tog för lång tid att få svar. Kolla din e-post om en stund – kom det ingen bekräftelse kan du försöka igen.",
    });
  }

  if (response.ok) {
    const ticket = await response.json();
    // A filled-in honeypot gives { url: null }: answer the same thank-you.
    return send(res, 200, { ok: true, number: ticket.number || null, url: ticket.url || null });
  }

  const { status, error } = await inkioError(response, FALLBACK);
  if (status !== 422) console.error("Inkio create-ticket: HTTP", response.status); // never the key nor the visitor's text
  return send(res, status, { ok: false, error });
};
