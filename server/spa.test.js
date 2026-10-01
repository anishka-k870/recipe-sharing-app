import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";

test("serves the production SPA and static files without swallowing API 404s", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recipe-sharing-spa-"));
  const distDirectory = join(directory, "dist");
  mkdirSync(join(distDirectory, "assets"), { recursive: true });
  writeFileSync(join(distDirectory, "index.html"), "<!doctype html><title>Recipe SPA</title>");
  writeFileSync(join(distDirectory, "assets", "app.js"), "window.recipeAppLoaded = true;");
  const server = createServer(createApp(
    {},
    {
      jwtSecret: "spa-test-secret-with-at-least-32-bytes",
      uploadDir: join(directory, "uploads"),
      serveClient: true,
      clientDistDir: distDirectory,
    },
  ));

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const homepage = await fetch(baseUrl, { headers: { Accept: "text/html" } });
    const clientRoute = await fetch(`${baseUrl}/recipes/soup`, { headers: { Accept: "text/html" } });
    const staticAsset = await fetch(`${baseUrl}/assets/app.js`);
    const missingAsset = await fetch(`${baseUrl}/assets/missing.js`, { headers: { Accept: "text/html" } });
    const missingApiRoute = await fetch(`${baseUrl}/api/not-a-route`, { headers: { Accept: "text/html" } });

    assert.equal(homepage.status, 200);
    assert.match(await homepage.text(), /Recipe SPA/);
    assert.equal(clientRoute.status, 200);
    assert.match(await clientRoute.text(), /Recipe SPA/);
    assert.equal(await staticAsset.text(), "window.recipeAppLoaded = true;");
    assert.equal(missingAsset.status, 404);
    assert.equal(missingApiRoute.status, 404);
    assert.deepEqual(await missingApiRoute.json(), { error: "API route not found." });
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
