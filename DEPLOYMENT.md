# Publish the demo and try your Gmail

The public demo and the private Gmail application have different hosting needs:

| Address                                | Purpose                                                     | Hosting                       |
| -------------------------------------- | ----------------------------------------------------------- | ----------------------------- |
| `https://hellokim.me/email-assistant/` | Public offline demo; visitors can try samples or paste text | Existing GitHub Pages site    |
| `https://mail.hellokim.me`             | Owner-only Gmail connection and optional live AI            | A Node.js host such as Render |

The existing website is in **Sleepycatfuji/skills-github-pages**; its `CNAME` is `hellokim.me`. Application source belongs in **Sleepycatfuji/ai-email-assistant**. A subdomain lets the Node server run independently while GitHub Pages continues serving the portfolio. The full backend expects to run at an origin root, so use a subdomain rather than a subdirectory for it.

## 1. Save the application on GitHub

Commit the source files, tests, lockfile, `render.yaml`, and `.github/workflows/ci.yml` in `Sleepycatfuji/ai-email-assistant`. Keep `.env`, credentials, `node_modules`, and generated outputs out of Git. Merge the reviewed application branch into `main`.

GitHub Actions will install the pinned development tools, run the core and browser checks, and upload an artifact named `email-assistant-demo`. This workflow prepares an artifact; it does not publish a website or create a server. These GitHub-hosted checks must run after pushing; local passing tests do not establish their outcome.

## 2. Publish the public demo on the existing Pages site

Build it from the application repository:

```sh
npm run build:demo
```

Copy **`dist/email-assistant/index.html`** to **`email-assistant/index.html`** in `Sleepycatfuji/skills-github-pages`. Alternatively, download the `email-assistant-demo` artifact from a successful Actions run and copy its `email-assistant/` directory into the Pages site.

Review and merge the site change into the branch published by GitHub Pages. In the site repository, check **Settings → Pages** to confirm the publishing source and wait for the Pages deployment to succeed. Then visit `https://hellokim.me/email-assistant/` and test a sample email. This is the intended URL, not confirmation that deployment has happened.

The generated HTML is self-contained and contains only offline rules and templates. It makes no network requests and cannot connect to anyone's Gmail. Do not add API keys to this file or to the Pages site. Later demo updates require rebuilding and copying the new HTML again. Preserve the existing site files and `CNAME` when copying.

## 3. Create the private Node.js host

Render is one supported option; the included `render.yaml` is a Blueprint for one web service. No hosting account has been created and no paid service has been ordered by this code.

1. Sign into [Render](https://dashboard.render.com/) and connect the application repository through Render's GitHub authorization flow.
2. Create a Blueprint from the reviewed application branch. Review the plan and any charges in Render before creating the service. The supplied file requests a free service; availability and limits depend on Render's current offering.
3. Use the generated service hostname initially if necessary. Set `APP_ORIGIN` to its full HTTPS origin, with no path or trailing slash, such as the exact `https://...onrender.com` address Render gives you. This address is a placeholder until Render assigns the real one.
4. Complete the Google setup below and enter the four Gmail settings securely in Render. Never put the client secret in the repository or chat.
5. Deploy. The service uses Node 24, `HOST=0.0.0.0`, Render's assigned `PORT`, and `/api/status` for its health check. No database is needed.

For another Node host, install with `npm ci --omit=dev --ignore-scripts`, set `NODE_ENV=production` and `HOST=0.0.0.0`, supply the same environment settings, and run `npm start` behind HTTPS.

Only one application instance is supported. Google access tokens and sessions are kept in server memory for up to an hour. Restarts, free-service sleep, or a deployment will sign you out; reconnect when needed. This version requests short-lived access, does not store refresh tokens, and does not use a persistent token database. Scaling or public multi-user use requires a separate implementation.

## 4. Configure your own Google account

You need access to a Google Cloud project and the Gmail account you want to test. A service-account credentials file is not a substitute for this personal Gmail OAuth flow.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a dedicated project and enable **Gmail API**.
2. Open **Google Auth Platform** (or **APIs & Services → OAuth consent screen**, depending on the current console). Set up the app's branding and contact details. Choose **External** for a personal Gmail account and keep the app in **Testing**. Add your own Gmail address as a **test user**.
3. Add the data access scope **`https://www.googleapis.com/auth/gmail.readonly`**, plus the basic `openid` and email identity scopes used by sign-in. Do not add Gmail send, compose, modify, or full-mail scopes.
4. Create an OAuth client of type **Web application**. Add this exact authorized redirect URI for the final custom domain:

   ```text
   https://mail.hellokim.me/auth/google/callback
   ```

   If testing with the assigned Render hostname first, also add its exact callback, `https://<your-actual-render-host>/auth/google/callback`. For local testing on your computer, add `http://127.0.0.1:3000/auth/google/callback` instead. The callback must match `APP_ORIGIN` plus `/auth/google/callback`, including host, scheme, port, and path. The cloud onboarding screen cannot receive an OAuth browser callback on its loopback address.

5. Copy the client ID and client secret into your host's secure environment settings. Set:

   | Variable               | Value                                                              |
   | ---------------------- | ------------------------------------------------------------------ |
   | `APP_ORIGIN`           | The actual HTTPS origin where this server is running               |
   | `GOOGLE_CLIENT_ID`     | Your web OAuth client ID                                           |
   | `GOOGLE_CLIENT_SECRET` | Your client secret; enter it securely                              |
   | `GMAIL_ALLOWED_EMAIL`  | The exact Gmail address you added as a test user                   |
   | `AI_API_KEY`           | Optional OpenAI API key; omit it to test Gmail using demo analysis |
   | `AI_MODEL`             | Optional model; defaults to `gpt-4.1-mini`                         |

6. Restart or redeploy after saving the settings. Click **Connect Gmail**, sign in as the configured owner, and review Google's permissions screen. During personal testing, Google may show an unverified/testing warning; proceed only after checking that the OAuth app is the project you created and that it asks for the read-only scope you configured. Workspace administrators may require approval. Testing access and grants can expire; reconnect as needed.

Gmail read-only is a restricted Google scope. This personal test setup is not approval for a public Gmail product. Offering Gmail integration to other users can require Google verification, a privacy policy, and additional compliance or security assessment depending on the use and exemptions. See Google's current [OAuth web-server documentation](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), and [Workspace API user-data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) before expanding beyond personal testing.

## 5. Add mail.hellokim.me

In Render's service settings, add `mail.hellokim.me` as a custom domain. At the DNS provider that manages `hellokim.me`, add the **`mail`** record using the exact CNAME target shown by Render. Preserve the existing apex and `www` records used by the portfolio.

Wait for DNS verification and the HTTPS certificate. Change `APP_ORIGIN` to `https://mail.hellokim.me`, confirm Google's redirect URI above, then redeploy. Your current Google session will be cleared. Visit the custom domain and reconnect Gmail. Do not point the Gmail app's subdomain at GitHub Pages.

## 6. Verify with your own account

1. Open the hosted app and confirm **Connect Gmail** is available.
2. Before sign-in, try a sample: demo analysis remains available. Hosted live AI requires the configured owner's signed-in session.
3. Connect the configured Gmail account. Confirm the connected email shown is yours.
4. Open **My Gmail**. It lists up to 10 recent inbox messages. Select one to preview its plain-text body. The app should not mark it as read or load tracking images.
5. Click **Analyze email**. Without an OpenAI key, the result is labelled as a demo suggestion. With a valid key, only this selected message's sender, subject, and body go to OpenAI when you request analysis. Review the result before using it.
6. Edit and copy or download the draft. This version cannot send mail or save a draft into Gmail.
7. Click **Disconnect**. Imported email content should clear and the inbox should require connection again. To remove the OAuth grant as well, remove Mailroom from your [Google Account third-party connections](https://myaccount.google.com/connections).

Only plain-text bodies are supported. HTML-only emails and attachments are not loaded. Long messages are explicitly limited to their first 12,000 characters. The app does not write mailbox content or tokens to disk. Hosting infrastructure and the AI provider have their own data policies; use sample emails until you have reviewed the services you choose.

## Current validation versus external setup

The automated tests use simulated Google and OpenAI responses. They validate OAuth state/PKCE, owner restrictions, short-lived cookies, read-only inbox retrieval, safe text rendering, provider failures, and disconnect behavior. They do not establish that your Google project is configured correctly, a real account can sign in, DNS resolves, or a hosting deployment has succeeded. Those require the manual checks above with your actual services.
