# Recipe Sharing App

A React recipe-sharing app with an Express API. SQLite stores accounts, recipes, comments, and ratings in local development and tests; production uses PostgreSQL. Passwords are bcryptjs hashes. API login returns a one-hour HS256 JWT; the web app uses a separate HttpOnly cookie session and never keeps the token in browser storage.

## Requirements

- Node.js 20.19+ or 22.12+
- npm

## Run locally

Set a strong JWT signing secret in the environment before starting the API. Generate a random value with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

In PowerShell, set the generated value for the current terminal session:

```powershell
$env:JWT_SECRET = "<paste-generated-value>"
```

Do not commit the secret or put it in frontend code. The API refuses to start if `JWT_SECRET` is missing or shorter than 32 bytes.

```sh
npm install
npm run dev
```

Open the Vite URL printed in the terminal. The Vite development server proxies `/api` requests to the Express server on port 3000. The API creates `data/users.sqlite` on first start unless `DATABASE_URL` is set, in which case it connects to PostgreSQL and applies the schema on startup. Registration is handled by `POST /api/auth/register`; login is handled by `POST /api/auth/login`.

## Recipe API

- `GET /api/recipes` lists recipes and is public.
- `GET /api/recipes?category=Dinner&ingredient=tomato` filters by exact category (case-insensitive) and ingredient substring (case-insensitive); when both are supplied, both must match.
- `POST /api/recipes` creates a recipe.
- `PUT /api/recipes/:id` replaces a recipe's editable fields.
- `DELETE /api/recipes/:id` deletes a recipe.
- `POST /api/recipes/images` accepts one authenticated multipart image in the `image` field and returns a public image reference (a local path in development or a Cloudinary HTTPS URL in production).
- `GET /api/recipes/:id/comments` lists recipe comments; `POST /api/recipes/:id/comments` adds one.
- `GET /api/recipes/:id/ratings` returns the average and count, plus `viewerRating` when called with a valid session/JWT (`null` when anonymous); `POST /api/recipes/:id/ratings` adds or replaces the authenticated user's rating.

The browser signs up at `POST /api/auth/register`, then signs in at `POST /api/auth/session`; that endpoint sets an HttpOnly, SameSite=Strict, one-hour cookie. `GET /api/auth/session` restores the current user and `POST /api/auth/logout` clears the cookie. The API's `POST /api/auth/login` remains available for non-browser clients and returns a bearer JWT. For production, the session cookie is also `Secure`; serve the frontend and API through the same origin (the Vercel/Netlify proxy rules below preserve this).

Recipe creation and editing require a session (or a bearer JWT for API clients). Mutations are restricted to the authenticated recipe owner; modifying another user's or a missing recipe returns `404`. Recipe fields are `title` (up to 120 characters), optional `category` (up to 80), `description` (up to 2000), non-empty `ingredients` and `steps` arrays (up to 100 entries each), and an `images` array of up to 10 references. Each ingredient is limited to 200 characters and each step to 1000. Comments are non-empty text up to 2000 characters. Ratings are integers from 1 to 5; a user's next rating replaces their previous rating for that recipe.

Uploaded images must be JPEG, PNG, or WebP and are limited to 5 MB each. The browser uploads selected images during the draft flow, before publishing. In local development and tests, uploads are written under `data/uploads/recipes` and served from `/uploads/recipes`; set `UPLOAD_DIR` to change the directory. In production, images are uploaded to Cloudinary and recipe records store their durable HTTPS URLs.

## Tests and production build

```sh
npm test
npm run test:api
npm run test:jest
npm run test:client
npm run build
```

`npm test` runs the Node API/schema suite, Jest auth and React component tests, and Vitest UI/integration tests. Jest's React wizard coverage lives in `src/recipe-submission-form.jest.test.jsx`; the real Express/SQLite signup-to-create-to-list integration test is `src/recipe-registration.integration.test.jsx`.

The frontend production output is `dist/`. In production, Express serves this build and its static assets from the same origin as the API, with SPA fallback for client-side routes and JSON 404s for unknown `/api` paths. The backend listens on `PORT` (3000 locally) and starts with `npm start`. Vite continues to proxy `/api` and `/uploads` to the local Express server during development.

## Deployment configuration

- **Heroku full-stack app:** `Procfile` runs `npm start`; Heroku's `heroku-postbuild` script runs `npm run build`, then Express serves both the generated React UI and API from one dyno/origin. Configure Heroku Postgres and set `DATABASE_URL`, `JWT_SECRET` (a unique random value of at least 32 bytes), `CLOUDINARY_URL` (Cloudinary's `cloudinary://API_KEY:API_SECRET@CLOUD_NAME` connection string), and `NODE_ENV=production`. Heroku supplies `PORT`. The API verifies TLS for its production PostgreSQL connection, creates missing application tables on startup, and adds the `recipes.category` column to an older compatible schema when needed. It refuses to start if required production configuration or the built `dist/index.html` is missing; production uploads never fall back to the ephemeral dyno filesystem.
- Vercel/Netlify rewrite files remain available for a separately hosted frontend, but are not required for the Heroku full-stack deployment.
- These files configure builds and routing only; no deployment or paid resource creation is performed by this repository setup.

**Existing data and schema:** Startup creates the PostgreSQL tables for users, recipes, comments, and ratings, and adds the `category` column if it is missing. This schema bootstrap does not copy existing data from a local SQLite file; SQLite users, recipes, comments, ratings, and local image files remain where they are. Import existing records and transfer/re-upload local images to Cloudinary as a separate, explicit migration before directing existing users to the production database. Do not point a production deployment at SQLite or assume its filesystem is durable.
