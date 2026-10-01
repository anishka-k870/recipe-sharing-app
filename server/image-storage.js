import cloudinary from "cloudinary";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export function createLocalImageStorage(uploadDir) {
  const directory = resolve(uploadDir);
  mkdirSync(directory, { recursive: true });
  return {
    publicPath: "/uploads/recipes",
    directory,
    async upload(buffer, extension) {
      const filename = `${randomUUID()}.${extension}`;
      await writeFile(join(directory, filename), buffer, { flag: "wx" });
      return `/uploads/recipes/${filename}`;
    },
  };
}

export function createCloudinaryImageStorage(cloudinaryUrl, configuredClient = cloudinary.v2) {
  const parsed = new URL(cloudinaryUrl);
  if (parsed.protocol !== "cloudinary:" || !parsed.hostname || !parsed.username || !parsed.password) {
    throw new Error("CLOUDINARY_URL must use the cloudinary://API_KEY:API_SECRET@CLOUD_NAME format.");
  }
  const client = configuredClient;
  client.config({ cloudinary_url: cloudinaryUrl });
  return {
    publicPath: null,
    upload(buffer) {
      return new Promise((resolve, reject) => {
        const stream = client.uploader.upload_stream(
          { folder: "recipe-sharing-app/recipes", resource_type: "image" },
          (error, result) => {
            if (error) return reject(error);
            if (!result?.secure_url) return reject(new Error("Cloudinary did not return a secure image URL."));
            return resolve(result.secure_url);
          },
        );
        stream.end(buffer);
      });
    },
  };
}
