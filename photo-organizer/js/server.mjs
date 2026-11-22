#!/usr/bin/env node
// Local photo server. The browser provides the interface; this process reads folders,
// creates folders and sends files to Trash with the current user permissions.
// Listens only on 127.0.0.1 and rejects requests from other origins.
import { execFile, spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { access, copyFile, link, mkdir, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 4321;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const INDEX_FILE = "photo-organizer-indice.json";
const VISION_FILE = "photo-organizer-vision.json";
const IMAGE = /\.(avif|bmp|gif|heic|heif|jpe?g|nef|png|tiff?|webp)$/i;
const CACHE = path.join(homedir(), "Library/Caches/photo-organizer");
const TRASH = "/usr/bin/trash";
const SIPS = "/usr/bin/sips";
const MAX_BODY = 64 * 1024 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".nef": "application/octet-stream",
};

let root = null;
let vision = {};
let meta = {};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const fingerprint = (info) => `${info.size}:${Math.floor(info.mtimeMs)}`;
const exists = (full) => access(full).then(() => true, () => false);
const toRelative = (full) => path.relative(root, full).split(path.sep).join("/");

/** Resolve a relative browser path within the selected root folder. */
function inside(relative) {
  if (!root) throw httpError(409, "Choose a folder first.");
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) throw httpError(400, "Invalid path.");
  const full = path.resolve(root, relative);
  if (!full.startsWith(root + path.sep)) throw httpError(400, "The path is outside the selected folder.");
  return full;
}

// Limit sips processes so a page of thumbnails does not spawn hundreds at once.
let active = 0;
const waiting = [];
async function limited(task) {
  if (active >= 4) await new Promise((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

async function openFolder(requested) {
  const full = path.resolve(String(requested || "").trim().replace(/^~(?=$|\/)/, homedir()));
  const info = await stat(full).catch(() => null);
  if (!info?.isDirectory()) throw httpError(404, `Folder not found: «${requested}».`);
  if (full === path.parse(full).root || full === homedir()) throw httpError(400, "Choose a photo folder, not the disk root or your home folder.");
  root = full;
  let index = null;
  try {
    index = JSON.parse(await readFile(path.join(root, INDEX_FILE), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Could not read ${INDEX_FILE}: ${error.message}`);
  }
  vision = {};
  meta = {};
  try {
    const saved = JSON.parse(await readFile(path.join(root, VISION_FILE), "utf8"));
    vision = saved.entries || {};
    meta = saved.meta || {};
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Could not read ${VISION_FILE}: ${error.message}`);
  }
  return { root, name: path.basename(root), index };
}

/** Allow destinations within the home directory or on an external drive. */
function outside(requested) {
  const full = path.resolve(String(requested || "").trim().replace(/^~(?=$|\/)/, homedir()));
  const allowed = (root && full.startsWith(root + path.sep)) || (full.startsWith(homedir() + path.sep) && !full.startsWith(path.join(homedir(), "Library") + path.sep)) || full.startsWith("/Volumes/");
  if (!allowed || full === homedir() || path.basename(full).startsWith(".")) throw httpError(400, "Choose a folder in your home directory or on an external drive.");
  return full;
}

async function makeFolder(requested) {
  const full = outside(requested);
  await mkdir(full, { recursive: true });
  return { path: full };
}

// Compile once per source version and keep the executable in the cache.
let helperPromise = null;
function visionHelper() {
  helperPromise ??= (async () => {
    const source = path.join(HERE, "vision.swift");
    const version = createHash("sha1").update(await readFile(source)).digest("hex").slice(0, 12);
    const binary = path.join(CACHE, `vision-${version}`);
    if (await exists(binary)) return binary;
    await mkdir(CACHE, { recursive: true });
    const temporary = `${binary}.${process.pid}.tmp`;
    try {
      await run("/usr/bin/swiftc", ["-O", source, "-o", temporary]);
    } catch (error) {
      throw httpError(501, `Could not prepare content recognition (swiftc): ${String(error.stderr || error.message).split("\n")[0]}`);
    }
    await rename(temporary, binary);
    return binary;
  })();
  helperPromise.catch(() => {
    helperPromise = null;
  });
  return helperPromise;
}

function runHelper(binary, paths, onlyMetadata) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, onlyMetadata ? ["--meta"] : [], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`recognition exited with code ${code}`))));
    child.stdin.end(paths.join("\n"));
  });
}

// Convert supported EXIF timestamps to ISO format; discard other formats.
function exifDate(text) {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || ""));
  return match && match[1] !== "0000" ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` : null;
}

async function recognize(items, onlyMetadata) {
  const binary = await visionHelper();
  const byFull = new Map();
  for (const item of items) {
    if (typeof item?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) || /\n/.test(item.path || "")) continue;
    byFull.set(inside(item.path), item.sha256);
  }
  const results = {};
  const output = byFull.size ? await runHelper(binary, [...byFull.keys()], onlyMetadata) : "";
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const data = JSON.parse(line);
    const sha256 = byFull.get(data.path);
    if (!sha256 || data.error) continue;
    results[sha256] = onlyMetadata
      ? { geo: Array.isArray(data.geo) ? data.geo.map((value) => Math.round(value * 1e5) / 1e5) : null, taken: exifDate(data.taken) }
      : { labels: data.labels || [], print: data.print || null, brightness: data.brightness ?? -1 };
  }
  Object.assign(onlyMetadata ? meta : vision, results);
  const temporary = path.join(root, `.${VISION_FILE}.tmp`);
  await writeFile(temporary, JSON.stringify({ format: "local-photo-organizer-vision", version: 1, entries: vision, meta }));
  await rename(temporary, path.join(root, VISION_FILE));
  return { results };
}

async function scan() {
  if (!root) throw httpError(409, "Choose a folder first.");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const relatives = entries
    .filter((entry) => entry.isFile() && IMAGE.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .filter((relative) => !relative.split(path.sep).some((part) => part.startsWith(".")));
  const files = [];
  for (let start = 0; start < relatives.length; start += 200) {
    const batch = await Promise.all(relatives.slice(start, start + 200).map(async (relative) => {
      const info = await stat(path.join(root, relative)).catch(() => null);
      return info && { path: relative.split(path.sep).join("/"), size: info.size, lastModified: Math.floor(info.mtimeMs) };
    }));
    files.push(...batch.filter(Boolean));
  }
  return files;
}

/** Cache JPEG previews outside the source folder, respecting orientation. */
async function preview(relative) {
  const full = inside(relative);
  const info = await stat(full);
  const key = createHash("sha1").update(`${full}\0${fingerprint(info)}`).digest("hex");
  const out = path.join(CACHE, `${key}.jpg`);
  if (await exists(out)) return out;
  await mkdir(CACHE, { recursive: true });
  const temporary = path.join(CACHE, `${key}.${process.pid}.${Date.now()}.tmp.jpg`);
  try {
    await limited(() => run(SIPS, ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "360", full, "--out", temporary]));
    await rename(temporary, out);
  } catch {
    await rm(temporary, { force: true });
    throw httpError(415, "No preview is available for this format.");
  }
  return out;
}

async function dimensions(relative) {
  const full = inside(relative);
  const { stdout } = await limited(() => run(SIPS, ["-g", "pixelWidth", "-g", "pixelHeight", full]));
  return {
    width: Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]) || 0,
    height: Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]) || 0,
  };
}

async function writeIndex(doc) {
  if (!root) throw httpError(409, "Choose a folder first.");
  if (doc?.format !== "local-photo-organizer" || !Array.isArray(doc.files)) throw httpError(400, "Invalid index.");
  const temporary = path.join(root, `.${INDEX_FILE}.tmp`);
  await writeFile(temporary, JSON.stringify(doc));
  await rename(temporary, path.join(root, INDEX_FILE));
  return { saved: doc.files.length };
}

/** Check that the file has not changed since analysis before modifying it. */
async function verified(item) {
  const full = inside(item?.path);
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw new Error("file no longer exists");
  if (fingerprint(info) !== item.fingerprint) throw new Error("file changed since analysis; analyze it again");
  return full;
}

async function trash(items) {
  if (!(await exists(TRASH))) throw httpError(501, "This macOS installation has no /usr/bin/trash; no files were deleted.");
  const done = [];
  const failed = [];
  const ready = [];
  for (const item of items) {
    try {
      ready.push([item, await verified(item)]);
    } catch (error) {
      failed.push({ path: item?.path, error: error.message });
    }
  }
  for (let start = 0; start < ready.length; start += 50) {
    const chunk = ready.slice(start, start + 50);
    await run(TRASH, chunk.map(([, full]) => full)).catch(() => {});
    for (const [item, full] of chunk) {
      if (await exists(full)) failed.push({ path: item.path, error: "macOS could not move the file to Trash" });
      else done.push(item.path);
    }
  }
  return { done, failed };
}

function destinationParts(destination) {
  const parts = String(destination || "").split(/[\\/]+/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.some((part) => part === ".." || part.startsWith(".") || /[<>:"|?*\u0000-\u001f]/.test(part))) {
    throw httpError(400, "Invalid folder name: avoid leading dots and these characters < > : \" | ? *.");
  }
  return parts;
}

/** Move without overwriting: link fails if the destination already exists. */
async function moveOne(full, directory) {
  const extension = path.extname(full);
  const stem = path.basename(full, extension);
  for (let number = 1; ; number += 1) {
    const target = path.join(directory, number === 1 ? `${stem}${extension}` : `${stem} (${number})${extension}`);
    try {
      await link(full, target);
      await unlink(full);
      return target;
    } catch (error) {
      if (error.code === "EEXIST") continue;
      if (!["EXDEV", "EPERM", "ENOTSUP", "EMLINK"].includes(error.code)) throw error;
      // Across volumes or without hard links: copy, verify, then remove the original.
      try {
        await copyFile(full, target, constants.COPYFILE_EXCL);
      } catch (copyError) {
        if (copyError.code === "EEXIST") continue;
        throw copyError;
      }
      const [source, copy] = await Promise.all([stat(full), stat(target)]);
      if (source.size !== copy.size) {
        await rm(target, { force: true });
        throw new Error("the copy does not match; the original was preserved");
      }
      await utimes(target, source.atime, source.mtime);
      await rm(full);
      return target;
    }
  }
}

async function copyOne(full, directory) {
  const extension = path.extname(full);
  const stem = path.basename(full, extension);
  const source = await stat(full);
  for (let number = 1; ; number += 1) {
    const target = path.join(directory, number === 1 ? `${stem}${extension}` : `${stem} (${number})${extension}`);
    try {
      await copyFile(full, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
    if ((await stat(target)).size !== source.size) {
      await rm(target, { force: true });
      throw new Error("the copy does not match; the original was preserved");
    }
    await utimes(target, source.atime, source.mtime);
    return target;
  }
}

async function move(items, destination, copying = false) {
  const directory = path.isAbsolute(String(destination || "").trim().replace(/^~(?=$|\/)/, homedir()))
    ? outside(destination)
    : inside(destinationParts(destination).join("/"));
  await mkdir(directory, { recursive: true });
  const moved = [];
  const failed = [];
  for (const item of items) {
    try {
      const full = await verified(item);
      if (!copying && path.dirname(full) === directory) continue;
      const target = await (copying ? copyOne : moveOne)(full, directory);
      // Remove files moved outside the root from the index: their destination is null.
      const kept = target.startsWith(root + path.sep);
      moved.push({ from: item.path, to: kept ? toRelative(target) : null, fingerprint: fingerprint(await stat(target)) });
    } catch (error) {
      failed.push({ path: item?.path, error: error.message });
    }
  }
  return copying ? { copied: moved, failed } : { moved, failed };
}

async function pickFolder() {
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose the photo folder")']);
    return { path: stdout.trim() };
  } catch {
    return { cancelled: true };
  }
}

function sendJson(response, data, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

async function sendFile(response, full, cacheControl = "no-store") {
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw httpError(404, "Not found.");
  response.writeHead(200, {
    "Content-Type": TYPES[path.extname(full).toLowerCase()] || "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": cacheControl,
  });
  createReadStream(full).pipe(response);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, "Request too large.");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = createServer(async (request, response) => {
  try {
    // Host validation prevents DNS rebinding; Origin validation rejects cross-origin actions.
    if (!HOSTS.has(request.headers.host)) throw httpError(403, "Host not allowed.");
    const url = new URL(request.url, `http://${request.headers.host}`);
    const query = url.searchParams.get("path");
    if (request.method === "GET") {
      if (url.pathname === "/") return await sendFile(response, path.join(HERE, "index.html"));
      if (url.pathname === "/js/app.js") return await sendFile(response, path.join(HERE, "js/app.js"));
      if (url.pathname === "/css/styles.css") return await sendFile(response, path.join(HERE, "css/styles.css"));
      if (url.pathname === "/api/state") return sendJson(response, { root });
      if (url.pathname === "/api/scan") return sendJson(response, { files: await scan() });
      if (url.pathname === "/api/file") return await sendFile(response, inside(query));
      if (url.pathname === "/api/preview") return await sendFile(response, await preview(query), "private, max-age=31536000, immutable");
      if (url.pathname === "/api/info") return sendJson(response, await dimensions(query));
      if (url.pathname === "/api/vision") return sendJson(response, { entries: root ? vision : {}, meta: root ? meta : {} });
      throw httpError(404, "Not found.");
    }
    if (request.method !== "POST") throw httpError(405, "Method not allowed.");
    if (request.headers.origin !== `http://${request.headers.host}` || !String(request.headers["content-type"]).startsWith("application/json")) {
      throw httpError(403, "Origin not allowed.");
    }
    const body = await readBody(request);
    if (url.pathname === "/api/pick") return sendJson(response, await pickFolder());
    if (url.pathname === "/api/open") return sendJson(response, await openFolder(body.path));
    if (url.pathname === "/api/index") return sendJson(response, await writeIndex(body.doc));
    if (url.pathname === "/api/trash") return sendJson(response, await trash(Array.isArray(body.items) ? body.items : []));
    if (url.pathname === "/api/recognize") return sendJson(response, await recognize(Array.isArray(body.items) ? body.items : [], body.mode === "meta"));
    if (url.pathname === "/api/mkdir") return sendJson(response, await makeFolder(body.path));
    if (url.pathname === "/api/copy") return sendJson(response, await move(Array.isArray(body.items) ? body.items : [], body.destination, true));
    if (url.pathname === "/api/move") return sendJson(response, await move(Array.isArray(body.items) ? body.items : [], body.destination));
    if (url.pathname === "/api/reveal") {
      await run("/usr/bin/open", ["-R", await verified(body)]);
      return sendJson(response, { ok: true });
    }
    throw httpError(404, "Not found.");
  } catch (error) {
    if (response.headersSent) return response.destroy();
    sendJson(response, { error: error.message }, error.status || 500);
  }
});

server.on("error", (error) => {
  console.error(error.code === "EADDRINUSE" ? `Port ${PORT} is in use. Is another instance running? Try PORT=4322.` : error.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", async () => {
  if (process.argv[2]) {
    try {
      await openFolder(process.argv[2]);
    } catch (error) {
      console.error(error.message);
    }
  }
  console.log(`Photo Organizer at ${ORIGIN} (Ctrl+C to stop)`);
  if (!process.env.NO_OPEN) execFile("/usr/bin/open", [ORIGIN]);
});
