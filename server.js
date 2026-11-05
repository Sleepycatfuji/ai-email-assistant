import http from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { AppError, analyze, validateInput } from "./assistant.js";
import { GmailConnection } from "./gmail.js";

const publicDir = new URL("./public/", import.meta.url);
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);

async function readJson(req) {
  if (
    !req.headers["content-type"]?.toLowerCase().startsWith("application/json")
  ) {
    throw new AppError(415, "Use application/json for this request.");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 40000) throw new AppError(413, "Email request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "The request must contain valid JSON.");
  }
}

export function createApp({
  apiKey = process.env.AI_API_KEY,
  model = process.env.AI_MODEL || "gpt-4.1-mini",
  fetchImpl = fetch,
  production = process.env.NODE_ENV === "production",
  gmailOptions = {},
} = {}) {
  const gmail = new GmailConnection({ production, fetchImpl, ...gmailOptions });
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    if (production)
      res.setHeader("Strict-Transport-Security", "max-age=15552000");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const json = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      if (req.method === "POST") {
        const origin = req.headers.origin;
        const allowed = gmail.origin
          ? [gmail.origin]
          : [`http://${req.headers.host}`, `https://${req.headers.host}`];
        if (origin && !allowed.includes(origin))
          throw new AppError(403, "Requests must come from this application.");
      }
      if (req.method === "GET" && path === "/auth/google/start")
        return gmail.begin(req, res);
      if (req.method === "GET" && path === "/auth/google/callback")
        return await gmail.callback(req, res, url);
      if (req.method === "GET" && path === "/api/gmail/status")
        return json(200, gmail.account(req));
      if (req.method === "POST" && path === "/api/gmail/disconnect")
        return json(200, await gmail.disconnect(req, res));
      if (req.method === "GET" && path === "/api/gmail/messages")
        return json(200, await gmail.list(req));
      if (req.method === "GET" && path.startsWith("/api/gmail/messages/"))
        return json(
          200,
          await gmail.read(req, path.slice("/api/gmail/messages/".length)),
        );
      if (req.method === "GET" && path === "/api/status") {
        return json(200, {
          status: "ok",
          mode: apiKey ? "live" : "demo",
          model: apiKey ? model : null,
        });
      }
      if (req.method === "POST" && path === "/api/analyze") {
        const input = validateInput(await readJson(req));
        const live =
          input.mode === "live" || (input.mode === "auto" && Boolean(apiKey));
        if (live && (production || gmail.configured)) {
          if (!gmail.configured)
            throw new AppError(
              503,
              "Hosted live AI requires owner-only Gmail sign-in. Configure Google OAuth and GMAIL_ALLOWED_EMAIL first.",
            );
          gmail.requireSession(req);
        }
        return json(200, await analyze(input, { apiKey, model, fetchImpl }));
      }
      if ((req.method === "GET" || req.method === "HEAD") && assets.has(path)) {
        const [file, type] = assets.get(path);
        const content = await readFile(new URL(file, publicDir));
        res.writeHead(200, { "Content-Type": type });
        return res.end(req.method === "HEAD" ? undefined : content);
      }
      json(404, { error: "Not found." });
    } catch (error) {
      // Never log email content, credentials, or upstream response bodies.
      json(error instanceof AppError ? error.status : 500, {
        error:
          error instanceof AppError
            ? error.message
            : "Something went wrong. Please try again.",
      });
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be between 1 and 65535.");
  const server = createApp();
  server.listen(port, host, () => {
    console.log(`Mailroom is running at http://${host}:${port}`);
    console.log(
      process.env.AI_API_KEY
        ? "Live AI enabled. Email text is sent to OpenAI when you click Analyze."
        : "Offline demo mode. No key needed; email text stays on this machine.",
    );
  });
  server.on("error", (error) => {
    console.error(`Server could not start: ${error.code || "unknown error"}`);
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close(() => process.exit(0)));
}
