import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import jwt from "jsonwebtoken";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";

const jwtSecret = "jest-test-secret-long-enough-to-have-32-bytes";
let database;
let server;
let baseUrl;
let uploadDir;

beforeAll(async () => {
  database = new Database(":memory:");
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  uploadDir = mkdtempSync(join(tmpdir(), "recipe-sharing-jest-"));
  server = createServer(createApp(database, { jwtSecret, uploadDir }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

describe("authentication endpoints", () => {
  it("signs up with a normalized email and stores a bcrypt hash", async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "  JEST@example.com ", password: "test-recipe-password" }),
    });
    const result = await response.json();
    const storedUser = database.prepare("SELECT email, password_hash FROM users WHERE id = ?")
      .get(result.user.id);

    expect(response.status).toBe(201);
    expect(result.user.email).toBe("jest@example.com");
    expect(result.password).toBeUndefined();
    expect(await bcrypt.compare("test-recipe-password", storedUser.password_hash)).toBe(true);
    expect(storedUser.password_hash).not.toBe("test-recipe-password");
  });

  it("logs in with valid credentials and returns an expiring signed token only then", async () => {
    const invalid = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "jest@example.com", password: "incorrect-password" }),
    });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: "Invalid email or password." });

    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "JEST@example.com", password: "test-recipe-password" }),
    });
    const result = await response.json();
    const claims = jwt.verify(result.token, jwtSecret, {
      algorithms: ["HS256"],
      issuer: "recipe-sharing-app",
    });

    expect(response.status).toBe(200);
    expect(Object.keys(result)).toEqual(["token"]);
    expect(claims.email).toBe("jest@example.com");
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it("creates and clears an HttpOnly cookie session without exposing the token", async () => {
    const response = await fetch(`${baseUrl}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "jest@example.com", password: "test-recipe-password" }),
    });
    const result = await response.json();
    const cookie = response.headers.get("set-cookie");
    const cookiePair = cookie.split(";")[0];
    const session = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: cookiePair },
    });

    expect(response.status).toBe(200);
    expect(result.token).toBeUndefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect((await session.json()).user.email).toBe("jest@example.com");

    const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST" });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    const clearedSession = await fetch(`${baseUrl}/api/auth/session`);
    expect(clearedSession.status).toBe(401);
  });
});
