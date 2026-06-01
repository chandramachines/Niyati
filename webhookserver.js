// webhookserver.js — IndiaMart Push API Webhook Receiver
// IndiaMart naye lead pe seedha yahan POST karta hai
// DOM scraping, MC window, page reload — sab band

const http = require("node:http");

/**
 * createWebhookServer(opts)
 * opts:
 *   port    — local port (default 3000)
 *   log     — log function
 *   onLead  — async function called for each new lead
 */
function createWebhookServer({ port = 3000, log = () => {}, onLead } = {}) {
  let _server = null;
  let _running = false;

  function parsePayload(body) {
    try {
      const parsed = JSON.parse(body);

      // Push API format: { body: { CODE: 200, STATUS, RESPONSE: {...} } }
      const resp = parsed?.body?.RESPONSE || parsed?.RESPONSE || parsed;
      if (!resp) return null;

      const code = parsed?.body?.CODE || parsed?.CODE;
      if (code && code !== 200) {
        log("info", `Webhook: Non-200 code: ${code}`);
        return null;
      }

      return {
        uniqueId:  String(resp.UNIQUE_QUERY_ID   || ""),
        queryType: String(resp.QUERY_TYPE         || ""),
        queryTime: String(resp.QUERY_TIME         || ""),
        name:      String(resp.SENDER_NAME        || ""),
        mobile:    String(resp.SENDER_MOBILE      || resp.SENDER_MOBILE_ALT || "").replace(/[^0-9]/g, "").slice(-10),
        email:     String(resp.SENDER_EMAIL       || ""),
        company:   String(resp.SENDER_COMPANY     || ""),
        address:   String(resp.SENDER_ADDRESS     || ""),
        city:      String(resp.SENDER_CITY        || ""),
        state:     String(resp.SENDER_STATE       || ""),
        pincode:   String(resp.SENDER_PINCODE     || ""),
        product:   String(resp.QUERY_PRODUCT_NAME || ""),
        message:   String(resp.QUERY_MESSAGE      || ""),
        subject:   String(resp.SUBJECT            || ""),
      };
    } catch (e) {
      log("error", `Webhook: JSON parse failed — ${e.message}`);
      return null;
    }
  }

  function start() {
    if (_running) return;

    _server = http.createServer((req, res) => {
      // Health check — Cloudflare tunnel test ke liye
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "niyati-webhook" }));
        return;
      }

      // IndiaMart Push API — POST request
      if (req.method === "POST") {
        let body = "";
        const MAX_BODY = 64 * 1024; // 64KB max — IndiaMart payload ~2KB hota hai
        let tooBig = false;
        req.on("data", chunk => {
          body += chunk.toString();
          if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
        });
        req.on("end", async () => {
          if (tooBig) { log("info", "Webhook: Payload too large — ignored"); return; }
          // IndiaMart ko turant 200 bhejo — nahi to retry loop mein fansega
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));

          log("info", `Webhook: POST received (${body.length} bytes)`);

          const lead = parsePayload(body);
          if (!lead) { log("info", "Webhook: Unparseable payload"); return; }

          if (!lead.name && !lead.mobile && !lead.email) {
            log("info", "Webhook: Empty lead — skipping");
            return;
          }

          log("info", `Webhook: Lead — ${lead.name} | ${lead.mobile} | ${lead.product}`);

          try {
            if (onLead) await onLead(lead);
          } catch (e) {
            log("error", `Webhook: onLead error — ${e.message}`);
          }
        });
        return;
      }

      res.writeHead(404); res.end("Not found");
    });

    _server.on("error", (e) => {
      log("error", e.code === "EADDRINUSE"
        ? `Webhook: Port ${port} already in use`
        : `Webhook: Server error — ${e.message}`);
    });

    _server.listen(port, "127.0.0.1", () => {
      log("info", `Webhook: Listening on http://localhost:${port}`);
      _running = true;
    });
  }

  function stop() {
    if (_server) {
      _server.close(() => log("info", "Webhook: Server stopped"));
      _server = null;
      _running = false;
    }
  }

  return { start, stop, get running() { return _running; }, port };
}

module.exports = { createWebhookServer };
