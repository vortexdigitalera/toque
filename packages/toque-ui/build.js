/**
 * Build script for the toque-ui Worker.
 *
 * Copies the Next.js static export from packages/toqueui/out into
 * packages/toque-ui/public, so the ASSETS binding can serve them.
 *
 * Run: node build.js  (or npm run build)
 */

import { cpSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const NEXTJS_OUT = join(ROOT, "packages", "toqueui", "out");
const PUBLIC_DIR = join(__dirname, "public");

console.log("[toque-ui] Building static assets...");

// Check that the Next.js export exists
if (!existsSync(NEXTJS_OUT)) {
  console.error(`[toque-ui] ERROR: Next.js export not found at ${NEXTJS_OUT}`);
  console.error("[toque-ui] Run `cd packages/toqueui && npx next build` first.");
  process.exit(1);
}

// Clean the public directory
if (existsSync(PUBLIC_DIR)) {
  rmSync(PUBLIC_DIR, { recursive: true, force: true });
}
mkdirSync(PUBLIC_DIR, { recursive: true });

// Copy the Next.js export into public/
cpSync(NEXTJS_OUT, PUBLIC_DIR, { recursive: true });

// Verify the copy
function countFiles(dir) {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      count += countFiles(full);
    } else {
      count++;
    }
  }
  return count;
}

const fileCount = countFiles(PUBLIC_DIR);
console.log(`[toque-ui] ✓ Copied ${fileCount} files to ${PUBLIC_DIR}`);

// List key files
const keyFiles = ["index.html", "entities.html", "audit.html", "settings.html", "users.html", "_redirects"];
for (const f of keyFiles) {
  if (existsSync(join(PUBLIC_DIR, f))) {
    console.log(`[toque-ui]   ✓ ${f}`);
  } else {
    console.log(`[toque-ui]   ✗ ${f} (missing)`);
  }
}

console.log("[toque-ui] Build complete. Run `npx wrangler dev` or `npx wrangler deploy`.");
