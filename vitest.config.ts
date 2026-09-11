import { defineConfig } from "vitest/config";

// Pure-logic tests. Nothing here touches the DOM, so vitest's default node environment is enough.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		coverage: { provider: "v8", include: ["src/**"], reporter: ["text", "text-summary"] },
	},
});
