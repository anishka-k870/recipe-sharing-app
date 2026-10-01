import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import RegistrationForm from "./registration-form.jsx";
import { createApp } from "../server/app.js";
import { createDatabase } from "../server/database.js";

const jwtSecret = "integration-test-secret-with-at-least-32-bytes";
const nativeFetch = globalThis.fetch;
const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
let server;
let database;
let tempDirectory;

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (createObjectUrlDescriptor) Object.defineProperty(URL, "createObjectURL", createObjectUrlDescriptor);
  else delete URL.createObjectURL;
  if (revokeObjectUrlDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
  else delete URL.revokeObjectURL;
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  database?.close();
  if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
  server = undefined;
  database = undefined;
  tempDirectory = undefined;
});

describe("registration-to-recipe integration", () => {
  it("registers, logs in, publishes a recipe, and fetches it in the recipe list", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "recipe-sharing-integration-"));
    database = createDatabase(join(tempDirectory, "integration.sqlite"));
    server = createServer(createApp(database, {
      jwtSecret,
      uploadDir: join(tempDirectory, "uploads"),
    }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    let cookie = "";

    vi.stubGlobal("fetch", async (input, init = {}) => {
      const headers = new Headers(init.headers || {});
      if (cookie) headers.set("Cookie", cookie);
      let body = init.body;
      if (body instanceof FormData) {
        const boundary = `integration-${randomUUID()}`;
        const parts = [];
        for (const [name, value] of body.entries()) {
          if (typeof value === "string") continue;
          parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.name}"\r\nContent-Type: ${value.type}\r\n\r\n`,
          ));
          parts.push(await readFileBytes(value));
          parts.push(Buffer.from("\r\n"));
        }
        parts.push(Buffer.from(`--${boundary}--\r\n`));
        body = Buffer.concat(parts);
        headers.set("Content-Type", `multipart/form-data; boundary=${boundary}`);
      }
      const response = await nativeFetch(new URL(input, baseUrl), {
        ...init,
        headers,
        body,
      });

      function readFileBytes(file) {
        if (typeof file.arrayBuffer === "function") {
          return file.arrayBuffer().then((buffer) => Buffer.from(buffer));
        }
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(Buffer.from(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(file);
        });
      }
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      return response;
    });

    render(<RegistrationForm />);
    fireEvent.change(await screen.findByLabelText("Email address"), { target: { value: "homecook@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "family-recipe-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Your account is ready. Sign in to start sharing recipes.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "family-recipe-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Recipes worth sharing." })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "+ Add a recipe" }));
    fireEvent.change(screen.getByLabelText("Recipe title"), { target: { value: "Sunday tomato soup" } });
    fireEvent.change(screen.getByLabelText("Category (optional)"), { target: { value: "Lunch" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "A slow-cooked family favorite." } });
    fireEvent.click(screen.getByRole("button", { name: /2 Ingredients & method/ }));
    fireEvent.change(screen.getByLabelText("Ingredient 1"), { target: { value: "Ripe tomatoes" } });
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Simmer until tender." } });
    fireEvent.click(screen.getByRole("button", { name: /3 Images & review/ }));
    expect(await screen.findByLabelText(/recipe images/i)).toBeTruthy();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:integration-preview" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    const pngHeader = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fireEvent.change(screen.getByLabelText(/recipe images/i), {
      target: { files: [new File([pngHeader], "soup.png", { type: "image/png" })] },
    });
    expect(await screen.findByText("Uploaded")).toBeTruthy();
    expect(database.prepare("SELECT COUNT(*) AS count FROM recipes").get().count).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Publish recipe" }));

    expect(await screen.findByRole("heading", { name: "Sunday tomato soup" })).toBeTruthy();
    expect(database.prepare("SELECT COUNT(*) AS count FROM users").get().count).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM recipes").get().count).toBe(1);
    expect(database.prepare("SELECT email FROM users").get().email).toBe("homecook@example.com");
    const imagePath = database.prepare("SELECT images FROM recipes").get().images;
    const [storedImage] = JSON.parse(imagePath);
    expect(storedImage).toMatch(/^\/uploads\/recipes\/[0-9a-f-]+\.png$/);
    expect(existsSync(join(tempDirectory, "uploads", storedImage.split("/").at(-1)))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "← Back to recipes" }));
    expect(await screen.findByRole("button", { name: /Sunday tomato soup/ })).toBeTruthy();
    expect(screen.getByText("A slow-cooked family favorite.")).toBeTruthy();

    const persisted = await nativeFetch(`${baseUrl}/api/recipes`).then((response) => response.json());
    expect(persisted.recipes).toHaveLength(1);
    expect(persisted.recipes[0]).toMatchObject({
      title: "Sunday tomato soup",
      category: "Lunch",
      ingredients: ["Ripe tomatoes"],
      steps: ["Simmer until tender."],
      images: [storedImage],
    });
  });
});
