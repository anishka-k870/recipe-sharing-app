import assert from "node:assert/strict";
import test from "node:test";
import {
  createPostgresDatabase,
  translateSqlitePlaceholders,
  validateProductionConfiguration,
} from "./database.js";
import { createCloudinaryImageStorage } from "./image-storage.js";

test("requires Postgres, Cloudinary, and a strong JWT secret in production", () => {
  assert.throws(
    () => validateProductionConfiguration({ NODE_ENV: "production" }),
    /DATABASE_URL, JWT_SECRET, CLOUDINARY_URL/,
  );
  assert.throws(
    () => validateProductionConfiguration({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://example",
      JWT_SECRET: "short",
      CLOUDINARY_URL: "cloudinary://key:secret@cloud",
    }),
    /at least 32 bytes/,
  );
  assert.doesNotThrow(() => validateProductionConfiguration({ NODE_ENV: "development" }));
});

test("translates positional SQLite placeholders into PostgreSQL parameters", () => {
  assert.equal(
    translateSqlitePlaceholders("SELECT * FROM recipes WHERE owner_id = ? AND id = ?"),
    "SELECT * FROM recipes WHERE owner_id = $1 AND id = $2",
  );
});

test("Postgres adapter returns inserted IDs and normalizes integer fields", async () => {
  const calls = [];
  const pool = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.startsWith("INSERT")) return { rowCount: 1, rows: [{ id: "42" }] };
      return { rowCount: 1, rows: [{ id: "42", owner_id: "9", rating_count: "3" }] };
    },
    async end() {},
  };
  const database = createPostgresDatabase("postgres://unused", pool);

  const inserted = await database.prepare("INSERT INTO recipes (owner_id) VALUES (?)").run(9);
  const result = await database.prepare("SELECT id, owner_id, rating_count FROM recipes WHERE id = ?").get(42);

  assert.equal(calls[0].sql, "INSERT INTO recipes (owner_id) VALUES ($1) RETURNING id");
  assert.deepEqual(calls[0].parameters, [9]);
  assert.equal(inserted.lastInsertRowid, 42);
  assert.equal(inserted.changes, 1);
  assert.deepEqual(result, { id: 42, owner_id: 9, rating_count: 3 });
  await database.close();
});

test("Postgres startup migration creates the application schema and category upgrade", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(sql);
      return { rowCount: 0, rows: [] };
    },
    async end() {},
  };
  const database = createPostgresDatabase("postgres://unused", pool);

  await database.migrate();

  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS users/);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS recipes/);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS recipe_comments/);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS recipe_ratings/);
  assert.match(statements[0], /ADD COLUMN IF NOT EXISTS category/);
  await database.close();
});

test("Cloudinary image storage returns a durable secure URL from the upload callback", async () => {
  let uploaded;
  const client = {
    config(options) {
      assert.match(options.cloudinary_url, /^cloudinary:\/\//);
    },
    uploader: {
      upload_stream(options, callback) {
        assert.equal(options.folder, "recipe-sharing-app/recipes");
        return {
          end(buffer) {
            uploaded = buffer;
            callback(null, { secure_url: "https://res.cloudinary.com/test/image/upload/recipe.png" });
          },
        };
      },
    },
  };
  const storage = createCloudinaryImageStorage("cloudinary://key:secret@example", client);

  assert.equal(await storage.upload(Buffer.from("image"), "png"), "https://res.cloudinary.com/test/image/upload/recipe.png");
  assert.deepEqual(uploaded, Buffer.from("image"));
  assert.equal(storage.publicPath, null);
  assert.throws(() => createCloudinaryImageStorage("https://example.com", client), /CLOUDINARY_URL/);
});
