import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDatabase } from "./database.js";

test("creates the recipe schema and upgrades existing recipe tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "recipe-sharing-db-"));
  const filename = join(directory, "users.sqlite");
  const legacy = new Database(filename);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      ingredients TEXT NOT NULL,
      steps TEXT NOT NULL,
      images TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  legacy.close();

  try {
    const database = createDatabase(filename);
    const columns = database.pragma("table_info(recipes)").map((column) => column.name);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((table) => table.name);
    assert.ok(columns.includes("category"));
    assert.ok(tables.includes("recipe_comments"));
    assert.ok(tables.includes("recipe_ratings"));
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
