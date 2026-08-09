import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env["CHRONOS_WEB_PORT"] ?? 4173);
const mediaTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const relative =
      pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const safe = normalize(relative);
    if (safe.startsWith("..") || safe.includes(":"))
      throw new Error("unsafe path");
    const body = await readFile(join(root, safe));
    response.writeHead(200, {
      "content-type": mediaTypes[extname(safe)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `Chronos Web preview: http://127.0.0.1:${String(port)}\n`,
  );
});
