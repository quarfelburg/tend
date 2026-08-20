import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const ARTIFACT_TYPES: Record<string, { directory: string; contentType: string }> = {
  ".html": { directory: "html", contentType: "text/html; charset=utf-8" },
  ".jpeg": { directory: "artifacts", contentType: "image/jpeg" },
  ".jpg": { directory: "artifacts", contentType: "image/jpeg" },
  ".pdf": { directory: "pdf", contentType: "application/pdf" },
  ".png": { directory: "artifacts", contentType: "image/png" },
};

export function artifactType(name: string) {
  return ARTIFACT_TYPES[path.extname(name).toLowerCase()];
}

export async function importArtifactFile(artifactsDir: string, sourcePath: string) {
  const name = path.basename(sourcePath);
  const type = artifactType(name);
  if (!type) throw new Error("Review artifacts must be HTML, PDF, PNG, or JPEG files.");
  const directory = path.join(artifactsDir, type.directory);
  await mkdir(directory, { recursive: true });
  await copyFile(sourcePath, path.join(directory, name));
  return { name, href: `/review-artifacts/${encodeURIComponent(name)}` };
}
