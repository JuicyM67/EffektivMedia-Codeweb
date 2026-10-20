// Shared helpers for the Inkio website-tickets integration (see Inkio-guide).
// Every call to Inkio is made from here, server to server. The website key
// lives only in the INKIO_WEBSITE_KEY environment variable.

const INKIO_API = "https://crm.inkio.se/api/website-tickets";
const TOKEN_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * Calls Inkio. Never forwards the visitor's headers (Inkio refuses a POST that
 * carries a browser's Origin header). Returns the raw fetch Response.
 *   query:     object  -> query string (GET calls)
 *   json:      object  -> JSON body (POST calls)
 *   multipart: { body: Buffer, contentType: string } -> forwarded as-is
 *   key:       true    -> sends X-Inkio-Website-Key
 */
async function inkio(name, { query, json, multipart, key = false } = {}) {
  const url = new URL(`${INKIO_API}/${name}`);
  if (query) url.search = new URLSearchParams(query).toString();

  const headers = { "Accept-Language": "sv" };
  if (key) {
    if (!process.env.INKIO_WEBSITE_KEY) {
      throw Object.assign(new Error("INKIO_WEBSITE_KEY is not set"), { code: "CONFIG" });
    }
    headers["X-Inkio-Website-Key"] = process.env.INKIO_WEBSITE_KEY;
  }

  let body;
  if (multipart) {
    headers["Content-Type"] = multipart.contentType;
    body = multipart.body;
  } else if (json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }

  return fetch(url, {
    method: json || multipart ? "POST" : "GET",
    headers,
    body,
    signal: AbortSignal.timeout(60000),
  });
}

/** Inkio's human-readable error message (422), or null. Errors may be HTML, not JSON. */
async function inkioMessage(response) {
  try {
    const data = await response.json();
    return (data && data.error && data.error.message) || null;
  } catch (e) {
    return null;
  }
}

/** Maps an Inkio error status to { status, error } for our own JSON answer. */
async function inkioError(response, fallback) {
  if (response.status === 422) {
    return { status: 422, error: (await inkioMessage(response)) || fallback };
  }
  if (response.status === 404) {
    return { status: 404, error: "Vi hittar inte ärendet. Kontrollera länken i ditt mejl." };
  }
  if (response.status === 429) {
    return { status: 429, error: "Det är många som skickar just nu. Försök igen om några minuter." };
  }
  if (response.status === 413) {
    return { status: 413, error: "Filerna är för stora. Skicka färre eller mindre filer." };
  }
  return { status: 502, error: fallback };
}

function send(res, status, payload) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  return res.status(status).json(payload);
}

/** True when the request comes from our own pages (simple CSRF guard). */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin GETs and non-browser clients send none
  try {
    return new URL(origin).host === req.headers.host;
  } catch (e) {
    return false;
  }
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "");
  return forwarded.split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "unknown";
}

/**
 * Best-effort per-visitor limit, so one visitor can't use up the Inkio quota
 * that all visitors share. Kept in memory per function instance.
 */
function createLimiter(max, windowMs) {
  const hits = new Map();
  return function limited(req) {
    const now = Date.now();
    const ip = clientIp(req);
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(ip, recent);
      return true;
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();
    return false;
  };
}

/** The ticket token from our X-Arende-Token header, lower-cased, or "" if malformed. */
function tokenFrom(req) {
  const token = String(req.headers["x-arende-token"] || "").trim();
  return TOKEN_PATTERN.test(token) ? token.toLowerCase() : "";
}

/** Reads the untouched request body (Vercel parses req.body lazily, so it stays unread). */
function readRawBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error("Body too large"), { code: "TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The boundary of a multipart/form-data Content-Type, or "". */
function multipartBoundary(contentType) {
  const match = /^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ""));
  return match ? match[1] || match[2] : "";
}

/** Prepends a plain text field to a multipart body, e.g. the ticket token. */
function prependField(body, boundary, name, value) {
  const part = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    "utf8"
  );
  return Buffer.concat([part, body]);
}

module.exports = {
  TOKEN_PATTERN,
  inkio,
  inkioError,
  send,
  isSameOrigin,
  createLimiter,
  tokenFrom,
  readRawBody,
  multipartBoundary,
  prependField,
};
