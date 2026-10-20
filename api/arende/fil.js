// GET /arende/<token>/fil/<id> (rewritten here by vercel.json) — a file on the
// ticket, fetched from Inkio and served from our own address as a download.

const { Readable } = require("stream");
const { inkio, TOKEN_PATTERN } = require("../_lib/inkio");

const ID_PATTERN = /^[0-9a-f-]{8,64}$/i;

function notFound(res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.status(404).send("Filen hittades inte.");
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed");
  }
  const token = String(req.query.token || "");
  const id = String(req.query.id || "");
  if (!TOKEN_PATTERN.test(token) || !ID_PATTERN.test(id)) return notFound(res);

  let response;
  try {
    response = await inkio("get-attachment", { query: { token: token.toLowerCase(), id } });
  } catch (err) {
    console.error("Inkio get-attachment failed:", err.name);
    return notFound(res);
  }
  if (!response.ok || !response.body) return notFound(res);

  res.statusCode = 200;
  res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");
  res.setHeader("Content-Disposition", response.headers.get("content-disposition") || "attachment");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex");
  const length = response.headers.get("content-length");
  if (length) res.setHeader("Content-Length", length);
  Readable.fromWeb(response.body).pipe(res);
};
