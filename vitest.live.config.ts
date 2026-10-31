import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

const pass = ["COOPER_LIVE_API_KEY", "COOPER_LIVE_INBOX_ID", "COOPER_LIVE_TO", "COOPER_LIVE_SUBJECT", "EMDASH_ENCRYPTION_KEY"];

export default defineConfig({
	plugins: [emdashPluginTest()],
	test: {
		include: ["tests/live/**/*.test.ts"],
		env: Object.fromEntries(pass.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))),
	},
});
