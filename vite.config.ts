import stylex from "@stylexjs/unplugin";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [mode === "test" ? stylex.rollup() : stylex.vite(), solid()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:3000", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
}));
