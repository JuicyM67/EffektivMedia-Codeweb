// POST /api/ansokan — job application from /jobba-hos-oss, emailed through Resend.
// The browser posts multipart/form-data (fields + files named "cv", "letter" and "referencefile");
// the files are checked here and attached to the email.

const {
  send,
  isSameOrigin,
  createLimiter,
  readRawBody,
  multipartBoundary,
} = require("./_lib/inkio");

const TO_EMAILS = [
  "matias@effektivmedia.nu",
  "hej@effektivmedia.nu",
  "alex@effektivmedia.nu",
  "dennis@effektivmedia.nu",
];
const FROM_EMAIL = "Effektiv Media <formular@effektivmedia.nu>";
const SUBJECT = "Ny ansökan för säljartjänst";

// Vercel refuses request bodies over 4.5 MB before the function runs.
const MAX_BODY = 4.5 * 1024 * 1024;
const limited = createLimiter(5, 10 * 60 * 1000); // 5 applications per visitor per 10 minutes
const FALLBACK = "Vi kunde inte skicka din ansökan just nu. Försök igen om en stund eller mejla hej@effektivmedia.nu.";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EXPERIENCE = ["Mindre än 2 år", "2–4 år", "5–10 år", "Mer än 10 år"];
const START = ["Direkt", "Inom 1 månad", "Inom 3 månader", "Senare"];

// First bytes of each accepted file type, so a renamed file can't get through.
const FILE_SIGNATURES = {
  pdf: [0x25, 0x50, 0x44, 0x46],
  docx: [0x50, 0x4b, 0x03, 0x04],
  doc: [0xd0, 0xcf, 0x11, 0xe0],
};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isFile(value) {
  return Boolean(value) && typeof value !== "string" && value.size > 0;
}

/** A Resend attachment named after the applicant, or null if the file isn't a real PDF/Word file. */
async function toAttachment(file, label, applicant) {
  const extension = (/\.([^.]+)$/.exec(file.name || "") || [])[1];
  const signature = FILE_SIGNATURES[String(extension).toLowerCase()];
  if (!signature) return null;

  const bytes = Buffer.from(await file.arrayBuffer());
  if (!signature.every((byte, index) => bytes[index] === byte)) return null;

  const safeName = applicant.replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 80);
  return {
    filename: `${label} - ${safeName || "sökande"}.${extension.toLowerCase()}`,
    content: bytes.toString("base64"),
  };
}

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

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("RESEND_API_KEY is not set");
    return send(res, 500, { ok: false, error: FALLBACK });
  }

  let form;
  try {
    const body = await readRawBody(req, MAX_BODY);
    form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
  } catch (err) {
    if (err.code === "TOO_LARGE") {
      return send(res, 413, { ok: false, error: "Filerna är för stora. Bifoga högst 4 MB totalt." });
    }
    return send(res, 400, { ok: false, error: "Ogiltig data." });
  }

  const field = (name, maxLength) => String(form.get(name) || "").trim().slice(0, maxLength);

  // Honeypot: real visitors never fill this hidden field.
  if (field("website", 200)) {
    return send(res, 200, { ok: true });
  }

  const name = field("name", 140);
  const email = field("email", 140);
  const phone = field("phone", 60);
  const city = field("city", 100);
  const linkedin = field("linkedin", 300);
  const experience = field("experience", 60);
  const start = field("start", 60);
  const message = field("message", 3000);
  const reference = field("reference", 300);
  const cv = form.get("cv");
  const letter = form.get("letter");
  const referenceFile = form.get("referencefile");

  if (
    !name ||
    !EMAIL_PATTERN.test(email) ||
    phone.replace(/\D/g, "").length < 6 ||
    !city ||
    !EXPERIENCE.includes(experience) ||
    !START.includes(start)
  ) {
    return send(res, 400, { ok: false, error: "Fyll i alla obligatoriska fält." });
  }
  if (!isFile(cv)) {
    return send(res, 400, { ok: false, error: "Bifoga ditt CV." });
  }

  const attachments = [await toAttachment(cv, "CV", name)];
  if (isFile(letter)) {
    attachments.push(await toAttachment(letter, "Personligt brev", name));
  }
  if (isFile(referenceFile)) {
    attachments.push(await toAttachment(referenceFile, "Referens", name));
  }
  if (attachments.includes(null)) {
    return send(res, 400, { ok: false, error: "Filerna måste vara i PDF- eller Word-format." });
  }

  if (limited(req)) {
    return send(res, 429, { ok: false, error: "Du har skickat flera ansökningar på kort tid. Vänta några minuter och försök igen." });
  }

  const rows = [
    ["Namn", name],
    ["E-post", email],
    ["Telefon", phone],
    ["Ort", city],
    ["Säljerfarenhet", experience],
    ["Kan börja", start],
    ["LinkedIn", linkedin],
    ["Referens", reference],
    ["Bifogat", attachments.map((file) => file.filename).join(", ")],
  ].filter(([, value]) => value);

  const html = `
    <h2>${escapeHtml(SUBJECT)}</h2>
    <table cellpadding="6" cellspacing="0">
      ${rows.map(([label, value]) => `<tr><td><strong>${escapeHtml(label)}</strong></td><td>${escapeHtml(value)}</td></tr>`).join("")}
    </table>
    ${message ? `<p><strong>Varför vill du jobba som säljare hos oss?</strong><br>${escapeHtml(message).replace(/\n/g, "<br>")}</p>` : ""}
  `;

  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: TO_EMAILS,
        reply_to: email,
        subject: SUBJECT,
        html,
        attachments,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resendRes.ok) {
      console.error("Resend error:", resendRes.status, await resendRes.text());
      return send(res, 502, { ok: false, error: FALLBACK });
    }

    return send(res, 200, { ok: true });
  } catch (err) {
    console.error("Application send failed:", err.name);
    return send(res, 500, { ok: false, error: FALLBACK });
  }
};
