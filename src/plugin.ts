import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

/**
 * Cooper Email transport for EmDash.
 *
 * Registers the exclusive `email:deliver` hook, so every email EmDash sends
 * (sign-in links, invites, and mail from other plugins through ctx.email)
 * goes out from a Cooper Email inbox over Cooper's HTTP API.
 *
 * Settings (edited on the plugin's Settings page):
 * - apiKey  : a Cooper API key (coop_live_...), stored encrypted
 * - inboxId : the Cooper inbox to send from (inb_...)
 */

export const COOPER_API = "https://cooperemail.com/api/v1";
const SETTINGS_PAGE = "/settings";

const INBOX_ID = /^inb_[A-Za-z0-9]+$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface OutgoingMessage {
	to: string;
	cc?: string[];
	replyTo?: string;
	subject: string;
	text: string;
	html?: string;
}

interface CooperConfig {
	apiKey: string;
	inboxId: string;
}

/** Error raised for any Cooper API failure. The message never contains the key. */
export class CooperError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly code?: string,
	) {
		super(message);
		this.name = "CooperError";
	}
}

function fetchFn(ctx: PluginContext) {
	if (!ctx.http) {
		throw new CooperError("Cooper Email needs the network:request capability");
	}
	return ctx.http.fetch;
}

async function readConfig(ctx: PluginContext): Promise<CooperConfig | null> {
	const apiKey = (await ctx.settings.get<string>("apiKey")) ?? "";
	const inboxId = (await ctx.settings.get<string>("inboxId")) ?? "";
	if (!apiKey || !inboxId) return null;
	return { apiKey, inboxId };
}

async function cooperError(response: Response): Promise<CooperError> {
	let code: string | undefined;
	let detail: string | undefined;
	try {
		const body = (await response.json()) as {
			error?: { code?: string; message?: string } | string;
		};
		if (typeof body.error === "string") code = body.error;
		else if (body.error) {
			code = body.error.code;
			detail = body.error.message;
		}
	} catch {
		// Non-JSON error body; fall back to the status line.
	}
	const label = code ?? `HTTP ${response.status}`;
	return new CooperError(
		detail ? `Cooper Email: ${label} (${detail})` : `Cooper Email: ${label}`,
		response.status,
		code,
	);
}

/** Build the JSON body for POST /inboxes/:id/messages. */
export function toCooperPayload(message: OutgoingMessage): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		to: [message.to],
		subject: message.subject,
		text: message.text,
	};
	if (message.html) payload.html = message.html;
	if (message.cc && message.cc.length > 0) payload.cc = message.cc;
	if (message.replyTo) payload.reply_to = message.replyTo;
	return payload;
}

/** Send one message from the configured Cooper inbox. Returns the Cooper message id. */
export async function sendViaCooper(
	ctx: PluginContext,
	config: CooperConfig,
	message: OutgoingMessage,
): Promise<string> {
	const response = await fetchFn(ctx)(
		`${COOPER_API}/inboxes/${encodeURIComponent(config.inboxId)}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
				"X-Client": "emdash-plugin-cooper-email",
			},
			body: JSON.stringify(toCooperPayload(message)),
		},
	);
	if (!response.ok) throw await cooperError(response);
	const sent = (await response.json()) as { id?: string };
	return sent.id ?? "";
}

/** Look up the inbox so the settings page can confirm the key and show the From address. */
async function fetchInbox(ctx: PluginContext, config: CooperConfig): Promise<{ email: string }> {
	const response = await fetchFn(ctx)(
		`${COOPER_API}/inboxes/${encodeURIComponent(config.inboxId)}`,
		{
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"X-Client": "emdash-plugin-cooper-email",
			},
		},
	);
	if (!response.ok) throw await cooperError(response);
	const inbox = (await response.json()) as { email?: string; inbox?: { email?: string } };
	return { email: inbox.email ?? inbox.inbox?.email ?? "" };
}

// ── Admin page (Block Kit) ─────────────────────────────────────────────────

type Toast = { message: string; type: "success" | "error" | "info" };

async function renderSettings(ctx: PluginContext, toast?: Toast) {
	const hasKey = ((await ctx.settings.get<string>("apiKey")) ?? "") !== "";
	const inboxId = (await ctx.settings.get<string>("inboxId")) ?? "";
	const fromAddress = (await ctx.kv.get<string>("state:fromAddress")) ?? "";
	const lastTestTo = (await ctx.kv.get<string>("state:lastTestTo")) ?? "";

	const status =
		hasKey && inboxId
			? fromAddress
				? `Site email is sent from **${fromAddress}**.`
				: "Configured. Save again or send a test to confirm the inbox."
			: "Not configured yet. Site email will fail until an API key and inbox ID are saved.";

	return {
		blocks: [
			{ type: "header", text: "Cooper Email" },
			{
				type: "context",
				text: "Delivers this site's email (sign-in links, invites, plugin mail) from a Cooper Email inbox. Create a free inbox and key at https://cooperemail.com.",
			},
			{ type: "section", text: status },
			{ type: "divider" },
			{
				type: "form",
				block_id: "cooper-settings",
				fields: [
					{
						type: "secret_input",
						action_id: "apiKey",
						label: "Cooper API key",
						has_value: hasKey,
					},
					{
						type: "text_input",
						action_id: "inboxId",
						label: "Inbox ID (inb_...)",
						initial_value: inboxId,
					},
				],
				submit: { label: "Save", action_id: "save" },
			},
			{ type: "divider" },
			{
				type: "form",
				block_id: "cooper-test",
				fields: [
					{
						type: "text_input",
						action_id: "testTo",
						label: "Send a test email to",
						initial_value: lastTestTo,
					},
				],
				submit: { label: "Send test email", action_id: "send_test" },
			},
		],
		...(toast ? { toast } : {}),
	};
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
	const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
	const inboxId = typeof values.inboxId === "string" ? values.inboxId.trim() : "";

	if (apiKey && !apiKey.startsWith("coop_")) {
		return renderSettings(ctx, { message: "That does not look like a Cooper API key (coop_...).", type: "error" });
	}
	if (!INBOX_ID.test(inboxId)) {
		return renderSettings(ctx, { message: "Inbox ID should look like inb_...", type: "error" });
	}

	if (apiKey) await ctx.settings.set("apiKey", apiKey);
	await ctx.settings.set("inboxId", inboxId);
	await ctx.kv.delete("state:fromAddress");

	const config = await readConfig(ctx);
	if (!config) {
		return renderSettings(ctx, { message: "Inbox saved. Add an API key to finish.", type: "info" });
	}
	try {
		const inbox = await fetchInbox(ctx, config);
		if (inbox.email) await ctx.kv.set("state:fromAddress", inbox.email);
		return renderSettings(ctx, {
			message: inbox.email ? `Saved. Sending from ${inbox.email}` : "Saved.",
			type: "success",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Could not reach Cooper Email";
		return renderSettings(ctx, { message: `Saved, but the check failed: ${message}`, type: "error" });
	}
}

async function sendTest(ctx: PluginContext, values: Record<string, unknown>) {
	const to = typeof values.testTo === "string" ? values.testTo.trim() : "";
	if (!EMAIL.test(to)) {
		return renderSettings(ctx, { message: "Enter a valid email address.", type: "error" });
	}
	const config = await readConfig(ctx);
	if (!config) {
		return renderSettings(ctx, { message: "Save an API key and inbox ID first.", type: "error" });
	}
	await ctx.kv.set("state:lastTestTo", to);
	try {
		const id = await sendViaCooper(ctx, config, {
			to,
			subject: "Test email from your EmDash site",
			text: "This test was sent by the Cooper Email plugin for EmDash. Site email is working.",
		});
		ctx.log.info("Cooper test email sent", { messageId: id });
		return renderSettings(ctx, { message: `Test sent (${id || "ok"})`, type: "success" });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Send failed";
		return renderSettings(ctx, { message, type: "error" });
	}
}

// ── Plugin definition ──────────────────────────────────────────────────────

const plugin: SandboxedPlugin = {
	hooks: {
		"email:deliver": {
			exclusive: true,
			handler: async (event, ctx) => {
				const config = await readConfig(ctx);
				if (!config) {
					throw new CooperError(
						"Cooper Email is not configured. Add an API key and inbox ID in the plugin settings.",
					);
				}
				const id = await sendViaCooper(ctx, config, event.message);
				ctx.log.info("Email delivered via Cooper", { source: event.source, messageId: id });
			},
		},
	},

	routes: {
		admin: {
			handler: async (routeCtx, ctx) => {
				const input = (routeCtx.input ?? {}) as {
					type?: string;
					page?: string;
					action_id?: string;
					values?: Record<string, unknown>;
				};
				if (input.type === "page_load" && input.page === SETTINGS_PAGE) {
					return renderSettings(ctx);
				}
				if (input.type === "form_submit" && input.action_id === "save") {
					return saveSettings(ctx, input.values ?? {});
				}
				if (input.type === "form_submit" && input.action_id === "send_test") {
					return sendTest(ctx, input.values ?? {});
				}
				return renderSettings(ctx);
			},
		},
	},
};

export default plugin;
