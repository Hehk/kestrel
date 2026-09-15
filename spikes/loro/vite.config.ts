import { defineConfig } from "vite";

export default defineConfig({
  root: "spikes/loro",
  build: { outDir: "../../crates/target/loro-spike", emptyOutDir: true, target: "esnext" },
});
