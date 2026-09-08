import stylex from "@stylexjs/unplugin";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [mode === "test" ? stylex.rollup() : stylex.vite(), solid()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
}));
