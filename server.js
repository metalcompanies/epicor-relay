/**
 * Epicor Kinetic ↔ Fixie Proxy Relay
 * ------------------------------------
 * All requests from the browser artifact hit /api/epicor/*
 * and are forwarded to Epicor through the Fixie egress proxy.
 *
 * Install deps:
 *   npm install express http-proxy-middleware https-proxy-agent cors dotenv
 *
 * .env file:
 *   FIXIE_URL=http://fixie:xg98QBqa0CGZywk@criterium.usefixie.com:80
 *   EPICOR_BASE_URL=https://your-epicor-server/EpicorERP
 *   PORT=3001
 */

require("dotenv").config();
const express        = require("express");
const cors           = require("cors");
const https          = require("https");
const http           = require("http");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent  } = require("http-proxy-agent");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── CORS: allow your frontend origin ──────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "*",   // lock down in production
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Api-Key"],
}));

// ── Config ─────────────────────────────────────────────────────────────────
const FIXIE_URL      = process.env.FIXIE_URL || "http://fixie:xg98QBqa0CGZywk@criterium.usefixie.com:80";
const EPICOR_BASE    = (process.env.EPICOR_BASE_URL || "").replace(/\/$/, "");

if (!EPICOR_BASE) {
  console.error("❌  EPICOR_BASE_URL is not set in .env");
  process.exit(1);
}

// Build proxy agents (Fixie is HTTP but Epicor target may be HTTPS)
const httpsAgent = new HttpsProxyAgent(FIXIE_URL);
const httpAgent  = new HttpProxyAgent(FIXIE_URL);

// ── Health check ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, proxy: FIXIE_URL, target: EPICOR_BASE }));

// ── Main relay: /api/epicor/* → EPICOR_BASE/* ──────────────────────────────
app.all("/api/epicor/*", async (req, res) => {
  // Strip the /api/epicor prefix to get the Epicor path
  const epicorPath = req.path.replace(/^\/api\/epicor/, "");
  const query      = Object.keys(req.query).length
    ? "?" + new URLSearchParams(req.query).toString()
    : "";
  const targetUrl  = `${EPICOR_BASE}${epicorPath}${query}`;

  console.log(`→ [${req.method}] ${targetUrl}`);

  try {
    // Forward most headers but strip host/connection
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders["host"];
    delete forwardHeaders["connection"];
    delete forwardHeaders["content-length"]; // will be recalculated

    if (req.body && Object.keys(req.body).length) {
      forwardHeaders["content-type"] = "application/json";
    }

    const isHttps = targetUrl.startsWith("https");
    const agent   = isHttps ? httpsAgent : httpAgent;
    const nodeLib = isHttps ? https : http;
    const url     = new URL(targetUrl);

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method:   req.method,
      headers:  forwardHeaders,
      agent,
    };

    const bodyStr = (req.body && Object.keys(req.body).length)
      ? JSON.stringify(req.body)
      : null;

    if (bodyStr) options.headers["content-length"] = Buffer.byteLength(bodyStr);

    const proxyReq = nodeLib.request(options, (proxyRes) => {
      console.log(`← [${proxyRes.statusCode}] ${targetUrl}`);

      // Relay status + headers back to browser
      res.status(proxyRes.statusCode);
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        // Skip headers that cause issues when relayed
        if (["transfer-encoding", "connection", "keep-alive"].includes(k.toLowerCase())) continue;
        res.setHeader(k, v);
      }

      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error("Proxy request error:", err.message);
      res.status(502).json({ error: "Proxy error", message: err.message });
    });

    if (bodyStr) proxyReq.write(bodyStr);
    proxyReq.end();

  } catch (err) {
    console.error("Relay error:", err.message);
    res.status(500).json({ error: "Relay error", message: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅  Epicor relay running on http://localhost:${PORT}`);
  console.log(`   Proxying via Fixie → ${EPICOR_BASE}`);
});
