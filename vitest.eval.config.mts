// `npm run eval`: the golden-set evaluation. It calls the real model, so it is
// kept apart from `npm test`, which never needs a key. It reads .env.local
// itself (Next.js does that for the app, but vitest doesn't).
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    env: loadEnv("development", process.cwd(), ""),
  },
});
