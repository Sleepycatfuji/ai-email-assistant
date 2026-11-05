# Mailroom — AI email assistant

A working first version of an email assistant: choose a sample email or paste your own, get a summary and action items, and edit a suggested reply. Copy your reply or download it as a text file.

**You can test it immediately without an API key.** Offline demo mode uses rules and reply templates. Live AI is optional. You can optionally connect your own Gmail with read-only access; the app never sends email. See [DEPLOYMENT.md](DEPLOYMENT.md) for GitHub Pages, server hosting, DNS, and Google OAuth setup.

## Start the app

**Just want to try the interface?** Open `mailroom-demo.html` directly in Chrome, Edge, Firefox, or Safari. This standalone file requires no installation or server. Choose a sample, click **Analyze email**, and try editing or downloading a reply. It uses the same offline demo rules as the server app and makes no network requests. If your file viewer displays source code or a thumbnail, download the HTML file and open the downloaded file in your browser.

To regenerate this standalone file from the source, run `npm run preview:build`. Live AI requires the server application below.

You need **Node.js 22.9 or newer**. There are no required third-party runtime dependencies, databases, or accounts.

```sh
cd ai-email-assistant
npm start
```

Open the local address printed in the terminal in a browser on the same computer. The default port is 3000. Stop the app with Ctrl+C. For automatic server restarts while editing, use `npm run dev`.

In the Codex cloud workspace, the repository is at `/workspace/ai-email-assistant`. The onboarding screen does not provide a browser preview. You can run the automated tests in the cloud; to try the interface yourself, download the source and run it on your own computer, or use a development environment that supports port forwarding.

## Try this first

1. Select **A fresh look at the launch plan** and click **Analyze email**.
2. Check the summary, Friday deadline, and requested next steps.
3. Change the tone to **Friendly**, then click **Regenerate**. The greeting text should change.
4. Edit the reply, replace `[Your name]`, and use **Copy reply** or **Download**.
5. Choose **Paste your own**, paste an email, and analyze it. An empty message should show a helpful error.
6. Select the invoice sample: it should show **Finance**, **High priority**, and **by tomorrow**.

Demo summaries are excerpts and draft replies are templates. They are deliberately labelled as demo suggestions. Review dates, facts, and any proposed commitments before using a draft. Switching emails or regenerating asks before discarding an edited draft. Reloading clears the current email and draft.

## Optional: enable live AI

1. Copy `.env.example` to `.env` without overwriting any existing settings.
2. Set `AI_API_KEY` to your own OpenAI API key **in that local file**, or supply it through your server's secure environment settings. Never commit the key or paste it into chat.
3. Optionally set `AI_MODEL` to a model available to your account that supports Chat Completions and JSON object responses. The default is `gpt-4.1-mini`.
4. Restart the server. The interface will show **Live AI configured**. This indicates a key is present; click **Analyze email** to verify the provider accepts it.

Live analysis sends the selected email's sender, subject, and body to `https://api.openai.com/v1/chat/completions`. Your account needs API access, available quota, and network access to `api.openai.com`. ChatGPT subscriptions do not include API usage. If a live request fails, the app shows an error and offers an explicit offline demo fallback.

The key stays on the server. This application does not write emails or replies to disk, log their content, or store them in browser storage. Live AI requests are subject to the provider's data policies. Downloading a draft explicitly saves a file on your computer; copying puts it on your clipboard.

## Automated checks

Core checks need only Node.js:

```sh
npm test
npm run check
```

For browser and accessibility checks, install the pinned development tools:

```sh
npm ci --cache /tmp/mailroom-npm-cache
npm run test:browser
npm run format:check
```

The browser check uses an installed Chromium at `/usr/bin/chromium`. To use a different Chromium or Chrome installation, set `CHROMIUM_PATH` to its executable path. The runner starts its own temporary server, exercises desktop and mobile flows, checks WCAG A/AA rules with axe, and saves screenshots under ignored `test-results/`. The npm cache flag above supports this cloud workspace; a normal `npm ci` also works where the default cache directory is writable.

Unit and HTTP tests cover demo behavior, validation, private-file protection, live-provider request formatting and response validation, and provider errors. Live-provider and Gmail tests use mocked responses and do not verify real credentials or access a mailbox or incur API usage. The browser suite also simulates live-provider failure to verify the demo fallback.

## Configuration and limitations

| Variable     | Default        | Purpose                         |
| ------------ | -------------- | ------------------------------- |
| `PORT`       | `3000`         | HTTP server port                |
| `HOST`       | `127.0.0.1`    | Interface to listen on          |
| `AI_API_KEY` | unset          | Optional server-side OpenAI key |
| `AI_MODEL`   | `gpt-4.1-mini` | Optional live AI model          |

This version supports personal Gmail testing through Google OAuth, restricted to the single verified address in `GMAIL_ALLOWED_EMAIL`. The server can list 10 inbox messages and import a selected plain-text email. Sessions and access tokens expire within an hour and are lost on server restart. HTML-only messages, attachments, Outlook, background synchronization, sending, Gmail draft creation, multi-user access, and persistent conversation history are not implemented. Hosted live AI requires the owner’s signed-in session. Use HTTPS and the deployment guide before connecting a real account.

The UI is plain HTML, CSS, and JavaScript. `server.js` serves a fixed asset list and API endpoints; `assistant.js` handles validation, demo analysis, and the optional provider request. `gmail.js` handles owner-only OAuth and read-only Gmail access. No build step is needed.
