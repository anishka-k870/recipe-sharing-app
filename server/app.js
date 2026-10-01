import bcrypt from "bcryptjs";
import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { extname, resolve } from "node:path";
import { createLocalImageStorage } from "./image-storage.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;
const TOKEN_LIFETIME = "1h";
const TOKEN_ISSUER = "recipe-sharing-app";
const SESSION_COOKIE = "recipe_session";
const TOKEN_LIFETIME_SECONDS = 60 * 60;
const MAX_RECIPE_ITEMS = 100;
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const RECIPE_SELECT = `
  SELECT r.id, r.owner_id, r.title, r.category, r.description, r.ingredients, r.steps,
         r.images, r.created_at, r.updated_at,
         (SELECT COUNT(*) FROM recipe_ratings rr WHERE rr.recipe_id = r.id) AS rating_count,
         (SELECT AVG(rr.rating) FROM recipe_ratings rr WHERE rr.recipe_id = r.id) AS average_rating
  FROM recipes r
`;

export function createApp(
  database,
  {
    jwtSecret = process.env.JWT_SECRET,
    uploadDir = process.env.UPLOAD_DIR || "data/uploads/recipes",
    imageStorage,
    serveClient = process.env.NODE_ENV === "production",
    clientDistDir = resolve(process.cwd(), "dist"),
  } = {},
) {
  if (typeof jwtSecret !== "string" || Buffer.byteLength(jwtSecret, "utf8") < 32) {
    throw new Error("JWT_SECRET must be set to a random secret of at least 32 bytes.");
  }
  if (process.env.NODE_ENV === "production" && !imageStorage) {
    throw new Error("Durable Cloudinary image storage is required in production.");
  }

  const storage = imageStorage || createLocalImageStorage(uploadDir);
  const app = express();
  const requireAuthentication = createAuthenticationMiddleware(database, jwtSecret);
  const optionalAuthentication = createOptionalAuthenticationMiddleware(database, jwtSecret);
  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  });

  app.use(express.json({ limit: "128kb" }));
  if (storage.publicPath) {
    app.use(storage.publicPath, express.static(storage.directory, {
      fallthrough: true,
      setHeaders(response) {
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      },
    }));
  }
  app.post("/api/auth/register", async (request, response, next) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return response.status(400).json({ error: "Email and password are required." });
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
      return response.status(400).json({ error: "Enter a valid email address." });
    }
    if (Array.from(password).length < MIN_PASSWORD_LENGTH) {
      return response.status(400).json({ error: "Password must be at least 8 characters long." });
    }
    if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
      return response.status(400).json({ error: "Password must be no more than 72 bytes." });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const result = await database
        .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
        .run(email, passwordHash);
      const user = await database
        .prepare("SELECT id, email, created_at FROM users WHERE id = ?")
        .get(result.lastInsertRowid);

      return response.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          createdAt: user.created_at,
        },
      });
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505") {
        return response.status(409).json({ error: "An account with this email already exists." });
      }
      return next(error);
    }
  });

  app.post("/api/auth/login", async (request, response, next) => {
    const credentials = readCredentials(request.body);
    if (credentials.error) return response.status(400).json({ error: credentials.error });
    try {
      const user = await authenticateCredentials(database, credentials.email, credentials.password);
      if (!user) {
        return response.status(401).json({ error: "Invalid email or password." });
      }
      return response.status(200).json({ token: createAccessToken(user, jwtSecret) });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/auth/session", async (request, response, next) => {
    const credentials = readCredentials(request.body);
    if (credentials.error) return response.status(400).json({ error: credentials.error });
    try {
      const user = await authenticateCredentials(database, credentials.email, credentials.password);
      if (!user) return response.status(401).json({ error: "Invalid email or password." });

      const token = createAccessToken(user, jwtSecret);
      response.setHeader("Set-Cookie", createSessionCookie(token));
      return response.status(200).json({
        user: { id: user.id, email: user.email },
        expiresIn: TOKEN_LIFETIME_SECONDS,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/auth/session", requireAuthentication, (request, response) => {
    return response.json({
      user: { id: request.userId, email: request.userEmail },
      expiresIn: Math.max(0, request.tokenExpiresAt - Math.floor(Date.now() / 1000)),
    });
  });

  app.post("/api/auth/logout", (request, response) => {
    response.setHeader("Set-Cookie", createSessionCookie("", true));
    return response.status(204).end();
  });

  app.get("/api/recipes", async (request, response, next) => {
    const category = readQueryFilter(request.query.category, 80);
    const ingredient = readQueryFilter(request.query.ingredient, 100);
    if (category.error || ingredient.error) {
      return response.status(400).json({
        error: "Invalid recipe filter.",
        details: { ...(category.error ? { category: category.error } : {}), ...(ingredient.error ? { ingredient: ingredient.error } : {}) },
      });
    }

    const conditions = [];
    const parameters = [];
    if (category.value !== undefined) {
      conditions.push(database.dialect === "postgres" ? "LOWER(r.category) = LOWER(?)" : "r.category = ? COLLATE NOCASE");
      parameters.push(category.value);
    }
    if (ingredient.value !== undefined) {
      conditions.push(database.dialect === "postgres" ? `
        EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(r.ingredients::jsonb) AS ingredient(value)
          WHERE LOWER(ingredient.value) LIKE LOWER(?) ESCAPE '\\'
        )
      ` : `
        EXISTS (
          SELECT 1 FROM json_each(r.ingredients) AS ingredient
          WHERE LOWER(ingredient.value) LIKE LOWER(?) ESCAPE '\\'
        )
      `);
      parameters.push(`%${escapeLikeTerm(ingredient.value)}%`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    try {
      const recipes = await database.prepare(`
        ${RECIPE_SELECT}
        ${where}
        ORDER BY r.created_at DESC, r.id DESC
      `).all(...parameters);
      return response.json({ recipes: recipes.map(serializeRecipe) });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/recipes", requireAuthentication, async (request, response, next) => {
    const validation = validateRecipe(request.body);
    if (validation.errors) {
      return response.status(400).json({ error: "Invalid recipe.", details: validation.errors });
    }

    try {
      const result = await database.prepare(`
        INSERT INTO recipes (owner_id, title, category, description, ingredients, steps, images)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.userId,
        validation.recipe.title,
        validation.recipe.category,
        validation.recipe.description,
        JSON.stringify(validation.recipe.ingredients),
        JSON.stringify(validation.recipe.steps),
        JSON.stringify(validation.recipe.images),
      );
      const recipe = await getRecipe(database, result.lastInsertRowid);
      return response.status(201).json({ recipe: serializeRecipe(recipe) });
    } catch (error) {
      return next(error);
    }
  });

  app.put("/api/recipes/:id", requireAuthentication, async (request, response, next) => {
    const id = parseRecipeId(request.params.id);
    if (id === null) return response.status(400).json({ error: "Recipe ID must be a positive integer." });

    const validation = validateRecipe(request.body);
    if (validation.errors) {
      return response.status(400).json({ error: "Invalid recipe.", details: validation.errors });
    }

    try {
      const result = await database.prepare(`
        UPDATE recipes
        SET title = ?, category = ?, description = ?, ingredients = ?, steps = ?, images = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND owner_id = ?
      `).run(
        validation.recipe.title,
        validation.recipe.category,
        validation.recipe.description,
        JSON.stringify(validation.recipe.ingredients),
        JSON.stringify(validation.recipe.steps),
        JSON.stringify(validation.recipe.images),
        id,
        request.userId,
      );
      if (result.changes === 0) return response.status(404).json({ error: "Recipe not found." });

      const recipe = await getRecipe(database, id);
      return response.json({ recipe: serializeRecipe(recipe) });
    } catch (error) {
      return next(error);
    }
  });

  app.delete("/api/recipes/:id", requireAuthentication, async (request, response, next) => {
    const id = parseRecipeId(request.params.id);
    if (id === null) return response.status(400).json({ error: "Recipe ID must be a positive integer." });

    try {
      const result = await database.prepare("DELETE FROM recipes WHERE id = ? AND owner_id = ?")
        .run(id, request.userId);
      if (result.changes === 0) return response.status(404).json({ error: "Recipe not found." });
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/recipes/:id/comments", async (request, response, next) => {
    const id = parseRecipeId(request.params.id);
    if (id === null) return response.status(400).json({ error: "Recipe ID must be a positive integer." });

    try {
      if (!await database.prepare("SELECT 1 FROM recipes WHERE id = ?").get(id)) {
        return response.status(404).json({ error: "Recipe not found." });
      }
      const comments = await database.prepare(`
        SELECT id, recipe_id, user_id, text, created_at
        FROM recipe_comments
        WHERE recipe_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(id);
      return response.json({ comments: comments.map(serializeComment) });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/recipes/:id/comments", requireAuthentication, async (request, response, next) => {
    const id = parseRecipeId(request.params.id);
    if (id === null) return response.status(400).json({ error: "Recipe ID must be a positive integer." });
    const text = request.body && typeof request.body.text === "string" ? request.body.text.trim() : "";
    if (!text || text.length > 2000) {
      return response.status(400).json({ error: "Comment must be non-empty and at most 2000 characters." });
    }

    try {
      if (!await database.prepare("SELECT 1 FROM recipes WHERE id = ?").get(id)) {
        return response.status(404).json({ error: "Recipe not found." });
      }
      const result = await database.prepare(`
        INSERT INTO recipe_comments (recipe_id, user_id, text)
        VALUES (?, ?, ?)
      `).run(id, request.userId, text);
      const comment = await database.prepare(`
        SELECT id, recipe_id, user_id, text, created_at
        FROM recipe_comments
        WHERE id = ?
      `).get(result.lastInsertRowid);
      return response.status(201).json({ comment: serializeComment(comment) });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/recipes/:id/ratings", optionalAuthentication, async (request, response, next) => {
    const id = parseRecipeId(request.params.id);
    if (id === null) return response.status(400).json({ error: "Recipe ID must be a positive integer." });

    try {
      if (!await database.prepare("SELECT 1 FROM recipes WHERE id = ?").get(id)) {
        return response.status(404).json({ error: "Recipe not found." });
      }
      const viewerRating = request.userId
        ? (await database.prepare("SELECT rating FROM recipe_ratings WHERE recipe_id = ? AND user_id = ?")
          .get(id, request.userId))?.rating ?? null
        : null;
      return response.json({ recipeId: id, ...await getRatingSummary(database, id), viewerRating });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/recipes/:id/ratings", requireAuthentication, async (request, response, next) => {
    const id = parseRecipeId(request.params.id);
    if (id === null) return response.status(400).json({ error: "Recipe ID must be a positive integer." });
    const rating = request.body && request.body.rating;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return response.status(400).json({ error: "Rating must be an integer from 1 to 5." });
    }

    try {
      if (!await database.prepare("SELECT 1 FROM recipes WHERE id = ?").get(id)) {
        return response.status(404).json({ error: "Recipe not found." });
      }
      await database.prepare(`
        INSERT INTO recipe_ratings (recipe_id, user_id, rating)
        VALUES (?, ?, ?)
        ON CONFLICT (recipe_id, user_id)
        DO UPDATE SET rating = excluded.rating, updated_at = CURRENT_TIMESTAMP
      `).run(id, request.userId, rating);
      const userRating = await database.prepare(`
        SELECT recipe_id, user_id, rating, created_at, updated_at
        FROM recipe_ratings
        WHERE recipe_id = ? AND user_id = ?
      `).get(id, request.userId);
      return response.status(200).json({
        rating: serializeRating(userRating),
        ...await getRatingSummary(database, id),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post(
    "/api/recipes/images",
    requireAuthentication,
    imageUpload.single("image"),
    async (request, response, next) => {
      if (!request.file) return response.status(400).json({ error: "An image file is required." });
      const imageType = detectImageType(request.file.buffer);
      if (!imageType || request.file.mimetype !== imageType.mime) {
        return response.status(400).json({ error: "Image must be a valid JPEG, PNG, or WebP file." });
      }

      try {
        const image = await storage.upload(request.file.buffer, imageType.extension);
        return response.status(201).json({ image });
      } catch (error) {
        return next(error);
      }
    },
  );

  app.use("/api", (request, response) => {
    return response.status(404).json({ error: "API route not found." });
  });

  if (serveClient) {
    app.use(express.static(clientDistDir, { fallthrough: true, index: false }));
    app.get("/{*path}", (request, response, next) => {
      if (
        !request.accepts("html")
        || extname(request.path)
        || request.path.startsWith("/uploads/")
      ) {
        return next();
      }
      return response.sendFile("index.html", { root: clientDistDir }, (error) => {
        if (error) next(error);
      });
    });
  }

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error instanceof SyntaxError && "body" in error) {
      return response.status(400).json({ error: "Request body must be valid JSON." });
    }
    if (error.type === "entity.too.large") {
      return response.status(413).json({ error: "Request body is too large." });
    }
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return response.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? "Image must be no larger than 5 MB." : "Invalid image upload.",
      });
    }
    console.error("Request failed:", error);
    return response.status(500).json({ error: "Unable to complete the request right now." });
  });

  return app;
}

function createAuthenticationMiddleware(database, jwtSecret) {
  return async (request, response, next) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.get("authorization") || "");
    const token = bearer ? bearer[1] : readSessionCookie(request.get("cookie"));
    if (!token) return response.status(401).json({ error: "Authentication required." });

    try {
      const claims = jwt.verify(token, jwtSecret, {
        algorithms: ["HS256"],
        issuer: TOKEN_ISSUER,
      });
      if (
        typeof claims === "string"
        || typeof claims.sub !== "string"
        || !/^[1-9]\d*$/.test(claims.sub)
        || !Number.isSafeInteger(claims.exp)
      ) {
        return response.status(401).json({ error: "Authentication required." });
      }
      const userId = Number(claims.sub);
      if (!Number.isSafeInteger(userId)) {
        return response.status(401).json({ error: "Authentication required." });
      }
      const user = await database.prepare("SELECT id, email FROM users WHERE id = ?").get(userId);
      if (!user) return response.status(401).json({ error: "Authentication required." });

      request.userId = user.id;
      request.userEmail = user.email;
      request.tokenExpiresAt = claims.exp;
      return next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        return response.status(401).json({ error: "Authentication required." });
      }
      return next(error);
    }
  };
}

function createOptionalAuthenticationMiddleware(database, jwtSecret) {
  return async (request, response, next) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.get("authorization") || "");
    const token = bearer ? bearer[1] : readSessionCookie(request.get("cookie"));
    if (!token) return next();

    try {
      const claims = jwt.verify(token, jwtSecret, {
        algorithms: ["HS256"],
        issuer: TOKEN_ISSUER,
      });
      if (
        typeof claims === "string"
        || typeof claims.sub !== "string"
        || !/^[1-9]\d*$/.test(claims.sub)
        || !Number.isSafeInteger(Number(claims.sub))
      ) {
        return next();
      }
      const user = await database.prepare("SELECT id, email FROM users WHERE id = ?").get(Number(claims.sub));
      if (user) {
        request.userId = user.id;
        request.userEmail = user.email;
      }
      return next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) return next();
      return next(error);
    }
  };
}

function readCredentials(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Email and password are required." };
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email) || !password) {
    return { error: "Enter a valid email address and password." };
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return { error: "Password must be no more than 72 bytes." };
  }
  return { email, password };
}

async function authenticateCredentials(database, email, password) {
  const user = await database
    .prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
    .get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return null;
  return user;
}

function createAccessToken(user, jwtSecret) {
  return jwt.sign(
    { email: user.email },
    jwtSecret,
    {
      algorithm: "HS256",
      subject: String(user.id),
      issuer: TOKEN_ISSUER,
      expiresIn: TOKEN_LIFETIME,
    },
  );
}

function createSessionCookie(token, clear = false) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const maxAge = clear ? 0 : TOKEN_LIFETIME_SECONDS;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function readSessionCookie(header = "") {
  for (const cookie of header.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function validateRecipe(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { errors: { recipe: "A recipe object is required." } };
  }

  const errors = {};
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const category = body.category === undefined ? "" : typeof body.category === "string" ? body.category.trim() : null;
  const description = typeof body.description === "string" ? body.description.trim() : null;
  if (!title || title.length > 120) errors.title = "Title is required and must be at most 120 characters.";
  if (category === null || category.length > 80) errors.category = "Category must be a string of at most 80 characters.";
  if (description === null || !description || description.length > 2000) {
    errors.description = "Description is required and must be at most 2000 characters.";
  }

  const ingredients = validateTextArray(body.ingredients, "Ingredients", MAX_RECIPE_ITEMS, 200, errors);
  const steps = validateTextArray(body.steps, "Steps", MAX_RECIPE_ITEMS, 1000, errors);

  let images = body.images;
  if (!Array.isArray(images) || images.length > MAX_IMAGES) {
    errors.images = `Images must be an array containing at most ${MAX_IMAGES} URLs.`;
    images = [];
  } else {
    images = images.map((image) => typeof image === "string" ? image.trim() : "");
    if (images.some((image) => !isImageReference(image))) {
      errors.images = "Each image must be a valid HTTP(S) URL or an uploaded recipe image path.";
    }
  }

  if (Object.keys(errors).length > 0) return { errors };
  return { recipe: { title, category, description, ingredients, steps, images } };
}

function validateTextArray(value, label, maxItems, maxLength, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    errors[label.toLowerCase()] = `${label} must contain between 1 and ${maxItems} items.`;
    return [];
  }
  const values = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (values.some((item) => item.length === 0 || item.length > maxLength)) {
    errors[label.toLowerCase()] = `Each ${label.toLowerCase()} item must be non-empty and at most ${maxLength} characters.`;
  }
  return values;
}

function isImageReference(value) {
  if (/^\/uploads\/recipes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i.test(value)) {
    return true;
  }
  if (!value || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function detectImageType(buffer) {
  if (
    buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff
  ) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (
    buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mime: "image/png", extension: "png" };
  }
  if (
    buffer.length >= 12
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", extension: "webp" };
  }
  return null;
}

function parseRecipeId(value) {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function readQueryFilter(value, maxLength) {
  if (value === undefined) return { value: undefined };
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    return { error: `Filter must be a non-empty value of at most ${maxLength} characters.` };
  }
  return { value: value.trim() };
}

function escapeLikeTerm(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function getRecipe(database, id) {
  return database.prepare(`
    ${RECIPE_SELECT}
    WHERE r.id = ?
  `).get(id);
}

function serializeRecipe(recipe) {
  return {
    id: recipe.id,
    ownerId: recipe.owner_id,
    title: recipe.title,
    category: recipe.category,
    description: recipe.description,
    ingredients: JSON.parse(recipe.ingredients),
    steps: JSON.parse(recipe.steps),
    images: JSON.parse(recipe.images),
    createdAt: recipe.created_at,
    updatedAt: recipe.updated_at,
    ratingCount: recipe.rating_count,
    averageRating: recipe.average_rating === null ? null : Number(recipe.average_rating),
  };
}

async function getRatingSummary(database, recipeId) {
  const summary = await database.prepare(`
    SELECT COUNT(*) AS rating_count, AVG(rating) AS average_rating
    FROM recipe_ratings
    WHERE recipe_id = ?
  `).get(recipeId);
  return {
    ratingCount: Number(summary.rating_count),
    averageRating: summary.average_rating === null ? null : Number(summary.average_rating),
  };
}

function serializeComment(comment) {
  return {
    id: comment.id,
    recipeId: comment.recipe_id,
    userId: comment.user_id,
    text: comment.text,
    createdAt: comment.created_at,
  };
}

function serializeRating(rating) {
  return {
    recipeId: rating.recipe_id,
    userId: rating.user_id,
    rating: rating.rating,
    createdAt: rating.created_at,
    updatedAt: rating.updated_at,
  };
}
