import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import jwt from "jsonwebtoken";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";

const testJwtSecret = "test-only-secret-with-at-least-32-bytes";

async function withApi(run) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const uploadDir = mkdtempSync(join(tmpdir(), "recipe-sharing-api-"));
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  database.exec(`
    CREATE TABLE recipes (
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
    )
  `);
  database.exec(`
    CREATE TABLE recipe_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE recipe_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (recipe_id, user_id)
    )
  `);
  const server = createServer(createApp(database, { jwtSecret: testJwtSecret, uploadDir }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    await run(`http://127.0.0.1:${address.port}`, database);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
    rmSync(uploadDir, { recursive: true, force: true });
  }
}

test("registers a normalized email and stores only a bcrypt hash", async () => {
  await withApi(async (url, database) => {
    const response = await fetch(`${url}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "  COOK@example.com ", password: "my-recipe-pass" }),
    });
    const result = await response.json();
    const stored = database.prepare("SELECT email, password_hash FROM users").get();

    assert.equal(response.status, 201);
    assert.equal(result.user.email, "cook@example.com");
    assert.equal("password" in result, false);
    assert.equal(stored.email, "cook@example.com");
    assert.notEqual(stored.password_hash, "my-recipe-pass");
    assert.equal(await bcrypt.compare("my-recipe-pass", stored.password_hash), true);
  });
});

test("rejects duplicate emails regardless of case", async () => {
  await withApi(async (url) => {
    const register = (email) => fetch(`${url}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "my-recipe-pass" }),
    });

    assert.equal((await register("cook@example.com")).status, 201);
    const duplicate = await register("COOK@example.com");
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: "An account with this email already exists." });
  });
});

test("validates email, password length, and malformed JSON", async () => {
  await withApi(async (url, database) => {
    const invalidEmail = await fetch(`${url}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "my-recipe-pass" }),
    });
    const shortPassword = await fetch(`${url}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "cook@example.com", password: "short" }),
    });
    const malformedJson = await fetch(`${url}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    assert.equal(invalidEmail.status, 400);
    assert.equal(shortPassword.status, 400);
    assert.equal(malformedJson.status, 400);
    assert.equal(database.prepare("SELECT count(*) AS count FROM users").get().count, 0);
  });
});

test("issues a signed one-hour JWT only for valid credentials", async () => {
  await withApi(async (url, database) => {
    const passwordHash = await bcrypt.hash("my-recipe-pass", 4);
    database.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(
      "cook@example.com",
      passwordHash,
    );

    const response = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: " COOK@example.com ", password: "my-recipe-pass" }),
    });
    const result = await response.json();
    const claims = jwt.verify(result.token, testJwtSecret, {
      algorithms: ["HS256"],
      issuer: "recipe-sharing-app",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(result), ["token"]);
    assert.equal(claims.sub, "1");
    assert.equal(claims.email, "cook@example.com");
    assert.ok(claims.exp - claims.iat <= 60 * 60);
    assert.ok(claims.exp - claims.iat >= 60 * 59);
  });
});

test("rejects unknown users and incorrect passwords with the same error", async () => {
  await withApi(async (url, database) => {
    const passwordHash = await bcrypt.hash("my-recipe-pass", 4);
    database.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(
      "cook@example.com",
      passwordHash,
    );
    const login = (email, password) => fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const wrongPassword = await login("cook@example.com", "wrong-password");
    const unknownUser = await login("other@example.com", "wrong-password");
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.deepEqual(await wrongPassword.json(), { error: "Invalid email or password." });
    assert.deepEqual(await unknownUser.json(), { error: "Invalid email or password." });
  });
});

test("requires a sufficiently long JWT secret", () => {
  const database = new Database(":memory:");
  assert.throws(() => createApp(database, { jwtSecret: "too-short" }), /at least 32 bytes/);
  database.close();
});

test("creates, lists, updates, and deletes recipes with owner-only mutations", async () => {
  await withApi(async (url, database) => {
    const ownerId = database.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run("owner@example.com", "unused").lastInsertRowid;
    const otherId = database.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run("other@example.com", "unused").lastInsertRowid;
    const tokenFor = (userId, email) => jwt.sign(
      { email },
      testJwtSecret,
      { algorithm: "HS256", subject: String(userId), issuer: "recipe-sharing-app", expiresIn: "1h" },
    );
    const ownerToken = tokenFor(ownerId, "owner@example.com");
    const otherToken = tokenFor(otherId, "other@example.com");
    const recipe = {
      title: "Garden tomato pasta",
      category: "Dinner",
      description: "A quick summer supper.",
      ingredients: ["200 g pasta", "2 ripe tomatoes"],
      steps: ["Boil the pasta.", "Toss with chopped tomatoes."],
      images: ["https://images.example.test/tomato-pasta.jpg"],
    };
    const send = (path, method = "GET", token, body) => fetch(`${url}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    assert.equal((await send("/api/recipes", "POST", undefined, recipe)).status, 401);
    const invalid = await send("/api/recipes", "POST", ownerToken, {
      ...recipe,
      title: " ",
      ingredients: [],
      images: ["javascript:alert(1)"],
    });
    assert.equal(invalid.status, 400);

    const created = await send("/api/recipes", "POST", ownerToken, recipe);
    const createdResult = await created.json();
    assert.equal(created.status, 201);
    assert.equal(createdResult.recipe.ownerId, ownerId);
    assert.deepEqual(createdResult.recipe.ingredients, recipe.ingredients);
    assert.deepEqual(createdResult.recipe.steps, recipe.steps);
    assert.deepEqual(createdResult.recipe.images, recipe.images);

    const listing = await (await send("/api/recipes")).json();
    assert.equal(listing.recipes.length, 1);
    assert.equal(listing.recipes[0].id, createdResult.recipe.id);

    const updatedData = {
      ...recipe,
      title: "Herby tomato pasta",
      description: "Finished with fresh basil.",
      ingredients: ["200 g pasta", "2 ripe tomatoes", "Fresh basil"],
      images: [],
    };
    const updated = await send(
      `/api/recipes/${createdResult.recipe.id}`,
      "PUT",
      ownerToken,
      updatedData,
    );
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).recipe.title, updatedData.title);

    const forbiddenUpdate = await send(
      `/api/recipes/${createdResult.recipe.id}`,
      "PUT",
      otherToken,
      recipe,
    );
    const forbiddenDelete = await send(
      `/api/recipes/${createdResult.recipe.id}`,
      "DELETE",
      otherToken,
    );
    assert.equal(forbiddenUpdate.status, 404);
    assert.equal(forbiddenDelete.status, 404);

    const deleted = await send(`/api/recipes/${createdResult.recipe.id}`, "DELETE", ownerToken);
    assert.equal(deleted.status, 204);
    assert.deepEqual((await (await send("/api/recipes")).json()).recipes, []);
  });
});

test("rejects malformed recipe IDs and invalid recipe fields", async () => {
  await withApi(async (url, database) => {
    const userId = database.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run("cook@example.com", "unused").lastInsertRowid;
    const token = jwt.sign(
      { email: "cook@example.com" },
      testJwtSecret,
      { algorithm: "HS256", subject: String(userId), issuer: "recipe-sharing-app", expiresIn: "1h" },
    );
    const invalidId = await fetch(`${url}/api/recipes/1.5`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    const invalidRecipe = await fetch(`${url}/api/recipes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Soup",
        description: "Good soup",
        ingredients: [" "],
        steps: ["Cook it"],
        images: [],
      }),
    });

    assert.equal(invalidId.status, 400);
    assert.equal(invalidRecipe.status, 400);
    assert.equal(database.prepare("SELECT count(*) AS count FROM recipes").get().count, 0);
  });
});

test("filters recipes by category and ingredient", async () => {
  await withApi(async (url, database) => {
    const ownerId = database.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run("filter@example.com", "unused").lastInsertRowid;
    const token = jwt.sign(
      { email: "filter@example.com" },
      testJwtSecret,
      { algorithm: "HS256", subject: String(ownerId), issuer: "recipe-sharing-app", expiresIn: "1h" },
    );
    const recipe = (title, category, ingredient) => ({
      title,
      category,
      description: "A test recipe.",
      ingredients: [ingredient],
      steps: ["Cook it."],
      images: [],
    });
    const add = (body) => fetch(`${url}/api/recipes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await add(recipe("Tomato pasta", "Dinner", "Fresh tomatoes"));
    await add(recipe("Tomato salad", "Lunch", "Cherry tomato"));
    await add(recipe("Apple tart", "Dessert", "Green apples"));

    const byCategory = await (await fetch(`${url}/api/recipes?category=dInNeR`)).json();
    const byIngredient = await (await fetch(`${url}/api/recipes?ingredient=TOMATO`)).json();
    const combined = await (await fetch(`${url}/api/recipes?category=Dinner&ingredient=tomato`)).json();
    const repeatedFilter = await fetch(`${url}/api/recipes?category=Dinner&category=Lunch`);

    assert.deepEqual(byCategory.recipes.map((item) => item.title), ["Tomato pasta"]);
    assert.deepEqual(byIngredient.recipes.map((item) => item.title).sort(), ["Tomato pasta", "Tomato salad"]);
    assert.deepEqual(combined.recipes.map((item) => item.title), ["Tomato pasta"]);
    assert.equal(repeatedFilter.status, 400);
    assert.equal(database.prepare("SELECT count(*) AS count FROM recipes").get().count, 3);
  });
});

test("uploads bounded image files and serves persisted image references", async () => {
  await withApi(async (url, database) => {
    const userId = database.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run("image@example.com", "unused").lastInsertRowid;
    const token = jwt.sign(
      { email: "image@example.com" },
      testJwtSecret,
      { algorithm: "HS256", subject: String(userId), issuer: "recipe-sharing-app", expiresIn: "1h" },
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp6sAAAAASUVORK5CYII=",
      "base64",
    );
    const form = new FormData();
    form.set("image", new Blob([png], { type: "image/png" }), "dish.png");
    const response = await fetch(`${url}/api/recipes/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const result = await response.json();
    const imageResponse = await fetch(`${url}${result.image}`);
    assert.equal(response.status, 201);
    assert.match(result.image, /^\/uploads\/recipes\/[0-9a-f-]+\.png$/);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get("content-type"), "image/png");

    const invalidForm = new FormData();
    invalidForm.set("image", new Blob(["<svg/>"], { type: "image/svg+xml" }), "dish.svg");
    const invalid = await fetch(`${url}/api/recipes/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: invalidForm,
    });
    assert.equal(invalid.status, 400);

    const tooLargeForm = new FormData();
    tooLargeForm.set("image", new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: "image/png" }), "large.png");
    const tooLarge = await fetch(`${url}/api/recipes/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: tooLargeForm,
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(database.prepare("SELECT count(*) AS count FROM recipes").get().count, 0);
  });
});

test("creates comments and upserts one validated rating per user and recipe", async () => {
  await withApi(async (url, database) => {
    const addUser = (email) => database.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run(email, "unused").lastInsertRowid;
    const ownerId = addUser("owner@example.com");
    const anotherId = addUser("another@example.com");
    const tokenFor = (userId, email) => jwt.sign(
      { email },
      testJwtSecret,
      { algorithm: "HS256", subject: String(userId), issuer: "recipe-sharing-app", expiresIn: "1h" },
    );
    const ownerToken = tokenFor(ownerId, "owner@example.com");
    const anotherToken = tokenFor(anotherId, "another@example.com");
    const inserted = database.prepare(`
      INSERT INTO recipes (owner_id, title, category, description, ingredients, steps, images)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ownerId, "Toast", "Breakfast", "Simple toast", '["bread"]', '["Toast it"]', "[]");
    const recipeId = inserted.lastInsertRowid;
    const commentUrl = `${url}/api/recipes/${recipeId}/comments`;
    const ratingUrl = `${url}/api/recipes/${recipeId}/ratings`;
    const postJson = (endpoint, token, body) => fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal((await postJson(commentUrl, ownerToken, { text: "A lovely idea." })).status, 201);
    assert.equal((await postJson(commentUrl, anotherToken, { text: "I added herbs." })).status, 201);
    const comments = await (await fetch(commentUrl)).json();
    assert.equal(comments.comments.length, 2);
    assert.deepEqual(comments.comments.map((comment) => comment.userId), [ownerId, anotherId]);
    assert.equal((await postJson(commentUrl, ownerToken, { text: " " })).status, 400);

    for (const rating of [0, 6, 2.5, "4"]) {
      assert.equal((await postJson(ratingUrl, ownerToken, { rating })).status, 400);
    }
    const firstRating = await postJson(ratingUrl, ownerToken, { rating: 4 });
    const updatedRating = await postJson(ratingUrl, ownerToken, { rating: 5 });
    const secondRating = await postJson(ratingUrl, anotherToken, { rating: 3 });
    assert.equal(firstRating.status, 200);
    assert.equal((await updatedRating.json()).rating.rating, 5);
    const result = await secondRating.json();
    assert.equal(result.ratingCount, 2);
    assert.equal(result.averageRating, 4);
    assert.equal(database.prepare("SELECT count(*) AS count FROM recipe_ratings").get().count, 2);
    assert.deepEqual(await (await fetch(ratingUrl)).json(), {
      recipeId,
      ratingCount: 2,
      averageRating: 4,
      viewerRating: null,
    });
    const personalized = await fetch(ratingUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal((await personalized.json()).viewerRating, 5);
    const invalidTokenStillListsPublicSummary = await fetch(ratingUrl, {
      headers: { Authorization: "Bearer not-a-valid-token" },
    });
    assert.equal(invalidTokenStillListsPublicSummary.status, 200);
    assert.equal((await invalidTokenStillListsPublicSummary.json()).viewerRating, null);

    const listed = await (await fetch(`${url}/api/recipes`)).json();
    assert.equal(listed.recipes[0].ratingCount, 2);
    assert.equal(listed.recipes[0].averageRating, 4);
  });
});
