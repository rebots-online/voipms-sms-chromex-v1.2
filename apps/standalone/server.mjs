import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const HOST = process.env.VOICEISH_HOST || "127.0.0.1";
const PORT = Number(process.env.VOICEISH_PORT || 8787);
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".wav": "audio/wav"
};

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https:; media-src 'self' data: https:; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function reject(response, status, message) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  response.end(message);
}

function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const relative = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = join(ROOT, relative);
  if (!file.startsWith(ROOT)) return reject(response, 403, "Forbidden.");
  let stat;
  try { stat = statSync(file); } catch { return reject(response, 404, "Not found."); }
  if (!stat.isFile()) return reject(response, 404, "Not found.");
  response.writeHead(200, {
    "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": relative === "index.html" ? "no-cache" : "public, max-age=300"
  });
  createReadStream(file).pipe(response);
}

const server = http.createServer(async (request, response) => {
  securityHeaders(response);
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    if (request.method !== "GET" && request.method !== "HEAD") return reject(response, 405, "Method not allowed.");
    return serveStatic(response, requestUrl.pathname);
  } catch (error) {
    return reject(response, 500, `Local web server error: ${error.message || error}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Voice-ish Web is running at http://${HOST}:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});
