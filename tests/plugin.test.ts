import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createPluginRuntimeTestHost,
	type PluginRuntimeTestHost,
} from "@emdash-cms/plugin-test";

// 32 bytes, base64url, in the format EMDASH_ENCRYPTION_KEY takes. Test-only.
const ENCRYPTION_KEY = `emdash_enc_v1_${"A".repeat(43)}`;
const API_KEY = "coop_live_test_not_a_real_key";
const INBOX = "inb_test123";
const SEND_URL = `https://cooperemail.com/api/v1/inboxes/${INBOX}/messages`;
const INBOX_URL = `https://cooperemail.com/api/v1/inboxes/${INBOX}`;

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

async function configuredHost() {
	vi.stubEnv("EMDASH_ENCRYPTION_KEY", ENCRYPTION_KEY);
	host = await createPluginRuntimeTestHost();
	await host.fixtures.plugin.setting("apiKey", API_KEY);
	await host.fixtures.plugin.setting("inboxId", INBOX);
	return host;
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function decode(body: Uint8Array) {
	return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
}

describe("email:deliver", () => {
	it("sends the message from the configured Cooper inbox", async () => {
		const h = await configuredHost();
		await h.http.respond(SEND_URL, json({ id: "msg_1", inbox_id: INBOX }));

		await h.transport.invokeHook("email:deliver", {
			source: "system",
			message: {
				to: "reader@example.com",
				cc: ["editor@example.com"],
				replyTo: "help@example.com",
				subject: "Your sign-in link",
				text: "Click to sign in",
				html: "<p>Click to sign in</p>",
			},
		});

		const requests = h.http.requests();
		expect(requests).toHaveLength(1);
		const request = requests[0]!;
		expect(request.url).toBe(SEND_URL);
		expect(request.method).toBe("POST");
		expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
		expect(request.headers["content-type"]).toBe("application/json");
		expect(decode(request.body)).toEqual({
			to: ["reader@example.com"],
			cc: ["editor@example.com"],
			reply_to: "help@example.com",
			subject: "Your sign-in link",
			text: "Click to sign in",
			html: "<p>Click to sign in</p>",
		});
	});

	it("omits optional fields that are not set", async () => {
		const h = await configuredHost();
		await h.http.respond(SEND_URL, json({ id: "msg_2" }));

		await h.transport.invokeHook("email:deliver", {
			source: "my-plugin",
			message: { to: "a@example.com", subject: "Hi", text: "Plain" },
		});

		expect(decode(h.http.requests()[0]!.body)).toEqual({
			to: ["a@example.com"],
			subject: "Hi",
			text: "Plain",
		});
	});

	it("fails loudly when Cooper rejects the send, without leaking the key", async () => {
		const h = await configuredHost();
		await h.http.respond(
			SEND_URL,
			json({ error: { code: "recipient_suppressed", message: "Address is suppressed." } }, 403),
		);

		const result = h.transport.invokeHook("email:deliver", {
			source: "system",
			message: { to: "bounced@example.com", subject: "Hi", text: "x" },
		});
		await expect(result).rejects.toThrow(/recipient_suppressed/);
		await expect(result).rejects.not.toThrow(API_KEY);
	});

	it("refuses to deliver when the plugin is not configured", async () => {
		host = await createPluginRuntimeTestHost();
		await expect(
			host.transport.invokeHook("email:deliver", {
				source: "system",
				message: { to: "a@example.com", subject: "Hi", text: "x" },
			}),
		).rejects.toThrow(/not configured/);
		expect(host.http.requests()).toHaveLength(0);
	});
});

describe("settings page", () => {
	it("renders valid Block Kit before configuration", async () => {
		host = await createPluginRuntimeTestHost();
		const page = await host.admin.loadPage("/settings");
		expect(JSON.stringify(page.blocks)).toContain("Not configured yet");
	});

	it("saves settings, encrypts the key, and confirms the From address", async () => {
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", ENCRYPTION_KEY);
		host = await createPluginRuntimeTestHost();
		await host.http.respond(INBOX_URL, json({ id: INBOX, email: "my-site@cooperemail.com" }));

		const page = await host.admin.submit("/settings", "save", {
			apiKey: API_KEY,
			inboxId: INBOX,
		});
		expect(page.toast).toMatchObject({ type: "success" });
		expect(JSON.stringify(page.blocks)).toContain("my-site@cooperemail.com");
		expect(JSON.stringify(page)).not.toContain(API_KEY);

		const raw = await host.inspect.settings.raw("apiKey");
		expect(raw).toMatchObject({ v: 1, kid: expect.any(String) });
		expect(JSON.stringify(raw)).not.toContain(API_KEY);
		await expect(host.inspect.setting("inboxId")).resolves.toBe(INBOX);

		const lookup = host.http.requests()[0]!;
		expect(lookup.url).toBe(INBOX_URL);
		expect(lookup.method).toBe("GET");
	});

	it("rejects a malformed inbox ID without saving", async () => {
		host = await createPluginRuntimeTestHost();
		const page = await host.admin.submit("/settings", "save", { inboxId: "nope" });
		expect(page.toast).toMatchObject({ type: "error" });
		await expect(host.inspect.setting("inboxId")).resolves.toBeNull();
	});

	it("sends a test email from the settings page", async () => {
		const h = await configuredHost();
		await h.http.respond(SEND_URL, json({ id: "msg_test" }));
		const page = await h.admin.submit("/settings", "send_test", { testTo: "me@example.com" });
		expect(page.toast).toMatchObject({ type: "success" });
		expect(decode(h.http.requests()[0]!.body)).toMatchObject({ to: ["me@example.com"] });
	});
});
