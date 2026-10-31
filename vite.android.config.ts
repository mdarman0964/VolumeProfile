import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Static, local-only web bundle for the Android shell.
 * This deliberately does not load TanStack Start, Nitro, auth, or a remote app URL.
 */
export default defineConfig({
  root: resolve(root, "android-web"),
  base: "./",
  resolve: {
    alias: { "@": resolve(root, "src") },
  },
  plugins: [tailwindcss(), react()],
  build: {
    outDir: resolve(root, "dist-android"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
