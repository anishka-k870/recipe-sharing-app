import Database from "better-sqlite3";
import pg from "pg";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const { Pool } = pg;

export function validateProductionConfiguration(environment = process.env) {
  const required = ["DATABASE_URL", "JWT_SECRET", "CLOUDINARY_URL"];
  const missing = required.filter((name) => !environment[name]?.trim());
  if (environment.NODE_ENV === "production" && missing.length > 0) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }
  if (environment.NODE_ENV === "production" && Buffer.byteLength(environment.JWT_SECRET, "utf8") < 32) {
    throw new Error("JWT_SECRET must be set to a random secret of at least 32 bytes.");
  }
}

export function createDatabase(filename = undefined) {
  const databaseUrl = filename === undefined ? process.env.DATABASE_URL : undefined;
  if (process.env.NODE_ENV === "production" && !databaseUrl) {
    throw new Error("DATABASE_URL is required in production; SQLite is only supported locally and in tests.");
  }
  if (databaseUrl) return createPostgresDatabase(databaseUrl);

  const sqliteFilename = filename || process.env.DATABASE_PATH || "data/users.sqlite";
  mkdirSync(dirname(sqliteFilename), { recursive: true });
  const database = new Database(sqliteFilename);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL,
      ingredients TEXT NOT NULL,
      steps TEXT NOT NULL,
      images TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS recipe_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS recipe_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (recipe_id, user_id)
    );
  `);
  const recipeColumns = database.pragma("table_info(recipes)").map((column) => column.name);
  if (!recipeColumns.includes("category")) {
    database.exec("ALTER TABLE recipes ADD COLUMN category TEXT NOT NULL DEFAULT ''");
  }
  return database;
}

export function createPostgresDatabase(connectionString, pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined,
})) {
  return {
    dialect: "postgres",
    prepare(sql) {
      const query = translateSqlitePlaceholders(sql);
      return {
        async get(...parameters) {
          const result = await pool.query(query, parameters);
          return normalizeRow(result.rows[0]);
        },
        async all(...parameters) {
          const result = await pool.query(query, parameters);
          return result.rows.map(normalizeRow);
        },
        async run(...parameters) {
          const statement = addReturningId(query);
          const result = await pool.query(statement, parameters);
          return {
            changes: result.rowCount,
            lastInsertRowid: result.rows[0]?.id === undefined ? undefined : Number(result.rows[0].id),
          };
        },
      };
    },
    async migrate() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id BIGSERIAL PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS recipes (
          id BIGSERIAL PRIMARY KEY,
          owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL,
          ingredients TEXT NOT NULL,
          steps TEXT NOT NULL,
          images TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        ALTER TABLE recipes ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';
        CREATE TABLE IF NOT EXISTS recipe_comments (
          id BIGSERIAL PRIMARY KEY,
          recipe_id BIGINT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS recipe_ratings (
          id BIGSERIAL PRIMARY KEY,
          recipe_id BIGINT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (recipe_id, user_id)
        );
      `);
    },
    close() {
      return pool.end();
    },
  };
}

export function translateSqlitePlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function addReturningId(sql) {
  if (!/^\s*INSERT\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) return sql;
  return `${sql.trim().replace(/;$/, "")} RETURNING id`;
}

function normalizeRow(row) {
  if (!row) return row;
  for (const key of ["id", "owner_id", "user_id", "recipe_id", "rating_count"]) {
    if (typeof row[key] === "string" && /^\d+$/.test(row[key])) row[key] = Number(row[key]);
  }
  return row;
}
