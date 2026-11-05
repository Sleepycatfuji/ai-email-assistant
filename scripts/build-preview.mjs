import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AppError, TONES, validateInput, demoAnalysis } from "../assistant.js";

const root = new URL("../", import.meta.url);

// A portable, offline-only demo. It contains no server configuration or credentials.
export async function buildPreview(
  destination = new URL("mailroom-demo.html", root),
) {
  const [template, css, app, icon] = await Promise.all(
    ["index.html", "style.css", "app.js", "favicon.svg"].map((file) =>
      readFile(new URL(`public/${file}`, root), "utf8"),
    ),
  );
  const script = `
const TONES = ${JSON.stringify(TONES)};
${AppError.toString()}
${validateInput.toString()}
${demoAnalysis.toString()}
// Module-local transport: no network requests are made by this demo.
const fetch = async (path, options = {}) => {
  options.signal?.throwIfAborted();
  try {
    if (path === '/api/status') return Response.json({ status: 'ok', mode: 'demo', model: null });
    if (path === '/api/gmail/status') return Response.json({ configured: false, connected: false, email: null });
    if (path === '/api/analyze') {
      const email = validateInput(JSON.parse(options.body));
      if (email.mode === 'live') throw new AppError(503, 'This standalone demo works offline only.');
      return Response.json({ mode: 'demo', ...demoAnalysis(email) });
    }
    return Response.json({ error: 'Not found.' }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 400 });
  }
};
${app}
document.getElementById('mode-label').textContent = 'Standalone offline demo';
document.getElementById('mode-description').textContent = 'You’re trying the standalone demo. Everything runs in your browser using rules and templates. No installation or account needed.';
document.getElementById('privacy-note').textContent = 'Email text stays in this browser tab. No network requests are made.';
const helpParagraphs = document.querySelectorAll('#help-dialog > p');
helpParagraphs[1].textContent = 'No inbox is connected. This standalone file processes emails in your browser and never sends email. Reloading clears your email and draft.';
helpParagraphs[2].textContent = 'For optional live AI, use the full server application and follow the repository README. This standalone demo cannot use an API key.';
`;
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  const hash = (text) => createHash("sha256").update(text).digest("base64");
  const iconUrl = `data:image/svg+xml;base64,${Buffer.from(icon).toString("base64")}`;
  let html = template
    .replace(
      '<link rel="stylesheet" href="/style.css" />',
      `<style>${css}</style>`,
    )
    .replace(
      '<script src="/app.js" type="module"></script>',
      `<script type="module">${safeScript}</script>`,
    )
    .replaceAll('"/favicon.svg"', `"${iconUrl}"`)
    .replace('href="/"', 'href="#"');
  html = html.replace(
    "<head>",
    `<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash(safeScript)}'; style-src 'sha256-${hash(css)}'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">`,
  );
  await writeFile(destination, html);
  return destination;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await buildPreview();
  console.log(
    "Built mailroom-demo.html. Open it directly in your browser; no server or API key is needed.",
  );
}
