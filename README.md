# Cooper Email for EmDash

Send your EmDash site's email through a [Cooper Email](https://cooperemail.com) inbox.

EmDash sends magic sign-in links, user invites, and mail from other plugins, but it needs an
email transport plugin to deliver them. This sandboxed plugin is that transport: it registers the
exclusive `email:deliver` hook and sends each message from a Cooper inbox through the Cooper REST API.

- Plain text, HTML, CC, and Reply-To are passed through.
- The API key is stored as an encrypted `secret` setting and is never shown again after saving.
- The plugin can only call `cooperemail.com` (`network:request` with `allowedHosts`).
- A settings page under **Plugins → Cooper Email** saves the key, confirms the From address, and sends a test email.
- If Cooper rejects a message, the send fails with Cooper's error code, so problems surface instead of mail silently disappearing.

## Setup

1. Create a free inbox and API key at [cooperemail.com](https://cooperemail.com).
2. Install **Cooper Email** from the EmDash plugin registry in your site's admin (or add it to `sandboxed: []`, see below).
3. Open **Plugins → Cooper Email**, paste the API key (`coop_...`) and inbox ID (`inb_...`), and click **Save**.
4. In **Settings → Email**, choose **cooper-email** as the provider and send a test email.

Sandboxed plugins need a sandbox runner: the Worker Loader binding on Cloudflare, or
`@emdash-cms/sandbox-workerd` on Node.js. Encrypted settings need `EMDASH_ENCRYPTION_KEY`.

## Develop

```sh
pnpm install
pnpm run validate     # check emdash-plugin.jsonc
pnpm run typecheck
pnpm run test         # sandboxed tests with mocked Cooper responses
pnpm run build        # dist/index.mjs, dist/plugin.mjs, dist/manifest.json
pnpm run bundle       # dist/cooper-email-<version>.tar.gz, checked against registry limits
```

### Live test against Cooper

`scripts/live-test.py SENDER.json RECEIVER.json` takes two JSON files, each with an `api_key`
for a throwaway Cooper account. It creates temporary inboxes, runs `tests/live` through EmDash's
production sandbox runner without HTTP mocks, confirms both emails arrived, and then deletes the
inboxes. Keys are passed through the environment and never printed.

### Try it in a local site

```sh
pnpm create emdash@latest my-site --template starter --platform node --pm pnpm --yes --install
cd my-site
pnpm add @emdash-cms/sandbox-workerd workerd file:../emdash-plugin-cooper-email
```

```js
// astro.config.mjs
import cooperEmail from "cooper-email";

emdash({
	// ...
	sandboxed: [cooperEmail],
	sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox",
});
```

Run `pnpm dev` in both directories, then open `/_emdash/admin` and go to **Plugins → Cooper Email**.

## Publish

Publishing uses the EmDash plugin CLI and an atproto (Bluesky) account. Do not use `pnpm publish`
or `pnpm login`; they are npm commands.

```sh
pnpm exec emdash-plugin login <bluesky-handle>   # browser OAuth, once per machine
# set "publisher" in emdash-plugin.jsonc to the DID printed by login
pnpm exec emdash-plugin publish
pnpm exec emdash-plugin info <bluesky-handle> cooper-email --version 0.1.0 --watch
```

After automated checks the plugin page appears at
`https://plugins.emdashcms.com/plugins/@<bluesky-handle>/cooper-email`.

## License

MIT © Avatar 8 LLC
