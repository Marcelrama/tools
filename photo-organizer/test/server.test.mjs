import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Only temporary files are used; no user photos are moved or deleted.
test("local server: scan, index, safe copy, and path/origin rejection", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "photo-organizer-test-"));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["js/server.mjs", folder], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, PORT: String(port), NO_OPEN: "1" },
    stdio: "pipe",
  });
  const closed = new Promise((resolve) => child.once("exit", resolve));
  const post = (route, body, headers = {}) => fetch(`${origin}${route}`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  try {
    await writeFile(path.join(folder, "sample.jpg"), "copy fixture");
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${origin}/api/state`)).ok; } catch {}
      if (ready) break;
      await delay(50);
    }
    assert.ok(ready, "the server must start");
    const page = await (await fetch(origin)).text();
    assert.ok(page.includes('href="/css/styles.css"'));
    assert.ok(page.includes('src="/js/app.js"'));
    assert.ok(!page.includes("<style>"));
    for (const [asset, type] of [["/css/styles.css", "text/css"], ["/js/app.js", "text/javascript"]]) {
      const response = await fetch(`${origin}${asset}`);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type").startsWith(type));
      assert.ok((await response.text()).length > 0);
    }
    assert.equal((await post("/api/open", { path: folder }, { Origin: "https://example.org" })).status, 403);
    const { files } = await (await fetch(`${origin}/api/scan`)).json();
    assert.equal(files.length, 1);
    const saved = await post("/api/index", { doc: { format: "local-photo-organizer", version: 3, files: [] } });
    assert.equal(saved.status, 200);
    const opened = await (await post("/api/open", { path: folder })).json();
    assert.equal(opened.index.format, "local-photo-organizer");
    const file = files[0];
    const item = { path: file.path, fingerprint: `${file.size}:${file.lastModified}` };
    const first = await (await post("/api/copy", { items: [item], destination: "copias" })).json();
    assert.equal(first.failed.length, 0);
    const second = await (await post("/api/copy", { items: [item], destination: "copias" })).json();
    assert.equal(second.failed.length, 0);
    assert.equal(await readFile(path.join(folder, "sample.jpg"), "utf8"), "copy fixture");
    assert.equal(await readFile(path.join(folder, "copias/sample.jpg"), "utf8"), "copy fixture");
    assert.equal(await readFile(path.join(folder, "copias/sample (2).jpg"), "utf8"), "copy fixture");
    assert.equal((await fetch(`${origin}/api/file?path=..%2Foutside.jpg`)).status, 400);
  } finally {
    child.kill();
    await closed;
    await rm(folder, { recursive: true, force: true });
  }
});
