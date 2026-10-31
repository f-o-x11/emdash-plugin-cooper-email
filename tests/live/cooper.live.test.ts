/**
 * Opt-in end-to-end test against the real Cooper Email API.
 *
 * Runs the built plugin in EmDash's production sandbox runner (no HTTP mocks),
 * saves settings through the admin route, then sends through `email:deliver`.
 * Run with `pnpm run test:live`; see scripts/live-test.sh, which creates and
 * deletes throwaway inboxes. The API key is never logged.
 */
import { afterAll, describe, expect, it } from "vitest";

import { createPluginTestHost, type PluginTestHost } from "@emdash-cms/plugin-test";

const apiKey = process.env.COOPER_LIVE_API_KEY ?? "";
const inboxId = process.env.COOPER_LIVE_INBOX_ID ?? "";
const to = process.env.COOPER_LIVE_TO ?? "";
const subject = process.env.COOPER_LIVE_SUBJECT ?? "EmDash plugin live test";

let host: PluginTestHost | undefined;
afterAll(async () => host?.dispose());

describe.skipIf(!apiKey || !inboxId || !to)("live Cooper Email", () => {
	it("saves settings and delivers a message through email:deliver", async () => {
		host = await createPluginTestHost();

		const saved = (await host.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save",
			values: { apiKey, inboxId },
		})) as { toast?: { type: string; message: string } };
		expect(saved.toast?.type, saved.toast?.message).toBe("success");

		await host.invokeHook("email:deliver", {
			source: "system",
			message: {
				to,
				subject,
				text: "Sent by the Cooper Email EmDash plugin live test.",
				html: "<p>Sent by the <b>Cooper Email</b> EmDash plugin live test.</p>",
			},
		});

		const page = (await host.invokeRoute("admin", {
			type: "form_submit",
			action_id: "send_test",
			values: { testTo: to },
		})) as { toast?: { type: string; message: string } };
		expect(page.toast?.type, page.toast?.message).toBe("success");
	}, 60_000);
});
