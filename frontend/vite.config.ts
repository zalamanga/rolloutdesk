import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/client": "http://127.0.0.1:8080",
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
