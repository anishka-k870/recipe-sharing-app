import { createApp } from "./app.js";
import { createDatabase, validateProductionConfiguration } from "./database.js";
import { createCloudinaryImageStorage } from "./image-storage.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

async function start() {
  let database;
  try {
    validateProductionConfiguration();
    const port = Number(process.env.PORT || 3000);
    const production = process.env.NODE_ENV === "production";
    const imageStorage = production
      ? createCloudinaryImageStorage(process.env.CLOUDINARY_URL)
      : undefined;
    const clientDistDir = resolve(process.cwd(), "dist");
    if (production && !existsSync(resolve(clientDistDir, "index.html"))) {
      throw new Error("Production client build not found; run `npm run build` before starting the server.");
    }
    database = createDatabase();
    if (database.migrate) await database.migrate();
    const app = createApp(database, { imageStorage, serveClient: production, clientDistDir });

    app.listen(port, () => {
      console.log(`Recipe Sharing API listening on port ${port}`);
    });
  } catch (error) {
    await database?.close?.();
    throw error;
  }
}

start().catch((error) => {
  console.error("Unable to start Recipe Sharing API:", error.message);
  process.exitCode = 1;
});
