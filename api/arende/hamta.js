// GET /api/arende/hamta — the ticket for the customer's ticket page.
// The token comes in the X-Arende-Token header, so it stays out of URLs and logs.

const { inkio, inkioError, send, tokenFrom } = require("../_lib/inkio");

const FALLBACK = "Vi kan inte visa ärendet just nu. Försök igen om en liten stund.";

function file(f) {
  return { id: String(f.id), name: String(f.name || "fil"), size: Number(f.size) || 0 };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { ok: false, error: "Method not allowed" });
  }
  const token = tokenFrom(req);
  if (!token) {
    return send(res, 404, { ok: false, error: "Vi hittar inte ärendet. Kontrollera länken i ditt mejl." });
  }

  let response;
  try {
    response = await inkio("get-ticket", { query: { token } });
  } catch (err) {
    console.error("Inkio get-ticket failed:", err.name);
    return send(res, 503, { ok: false, error: FALLBACK });
  }

  if (!response.ok) {
    const { status, error } = await inkioError(response, FALLBACK);
    if (status !== 404) console.error("Inkio get-ticket: HTTP", response.status);
    return send(res, status === 404 ? 404 : 503, { ok: false, error });
  }

  const t = await response.json();
  return send(res, 200, {
    ok: true,
    ticket: {
      number: t.number,
      subject: t.subject,
      status: t.status,
      createdAt: t.created_at,
      modifiedAt: t.modified_at,
      contactName: t.contact_name,
      description: t.description,
      attachments: (t.attachments || []).map(file),
      canReply: Boolean(t.can_reply),
      canSolve: Boolean(t.can_solve),
      messages: (t.messages || []).map((m) => ({
        id: m.id,
        author: m.author_name,
        fromCustomer: Boolean(m.from_customer),
        channel: m.channel,
        content: m.content,
        attachments: (m.attachments || []).map(file),
        createdAt: m.created_at,
      })),
    },
  });
};
