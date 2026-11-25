// Copies the static hub files next to the compiled client: dist/web/index.html and dist/web/assets/styles.css.
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist/web/assets", { recursive: true });
await cp("apps/web/public/index.html", "dist/web/index.html");
await cp("apps/web/public/styles.css", "dist/web/assets/styles.css");
console.log("copied hub static files to dist/web");
