import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "./assistant.js";

const READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const random = () => randomBytes(32).toString("base64url");
const minute = 60000;

export class GmailConnection {
  constructor({
    clientId = process.env.GOOGLE_CLIENT_ID,
    clientSecret = process.env.GOOGLE_CLIENT_SECRET,
    allowedEmail = process.env.GMAIL_ALLOWED_EMAIL,
    origin = process.env.APP_ORIGIN,
    production = process.env.NODE_ENV === "production",
    fetchImpl = fetch,
    now = Date.now,
  } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.allowedEmail = allowedEmail?.trim().toLowerCase();
    this.production = production;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sessions = new Map();
    this.origin = origin ? new URL(origin).origin : null;
    if (origin) {
      const parsed = new URL(origin);
      if (
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname !== "/"
      ) {
        throw new Error(
          "APP_ORIGIN must be a plain origin, without credentials, a path, query, or fragment.",
        );
      }
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(
        parsed.hostname,
      );
      if (
        parsed.protocol !== "https:" &&
        !(parsed.protocol === "http:" && local && !production)
      ) {
        throw new Error(
          "APP_ORIGIN must use HTTPS, except for local development.",
        );
      }
    }
    this.secure = this.origin?.startsWith("https://") || production;
    this.cookieName = this.secure ? "__Host-mailroom" : "mailroom";
    this.configured = Boolean(
      this.clientId &&
      this.clientSecret &&
      this.allowedEmail?.includes("@") &&
      this.origin,
    );
  }

  #cookie(res, value, seconds) {
    res.setHeader(
      "Set-Cookie",
      `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.secure ? "; Secure" : ""}`,
    );
  }

  #session(req) {
    const match = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${this.cookieName}=`));
    const id = match?.slice(this.cookieName.length + 1);
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const data = this.sessions.get(id);
    if (!data) return null;
    if (data.expires <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return { id, ...data };
  }

  #prune() {
    for (const [id, session] of this.sessions) {
      if (session.expires <= this.now()) this.sessions.delete(id);
    }
    if (this.sessions.size >= 1000)
      throw new AppError(
        429,
        "Too many sign-in attempts. Please try again later.",
      );
  }

  account(req) {
    const session = this.#session(req);
    return {
      configured: this.configured,
      connected: Boolean(session?.email),
      email: session?.email || null,
    };
  }

  requireSession(req) {
    const session = this.#session(req);
    if (!session?.email || !session.accessToken)
      throw new AppError(401, "Connect your Gmail account again to continue.");
    return session;
  }

  begin(req, res) {
    if (!this.configured)
      throw new AppError(
        503,
        "Gmail sign-in is not configured. See the deployment guide for the required Google OAuth settings.",
      );
    this.#prune();
    const previous = this.#session(req);
    if (previous) this.sessions.delete(previous.id);
    const id = random();
    const state = random();
    const verifier = random();
    this.sessions.set(id, {
      state,
      verifier,
      expires: this.now() + 10 * minute,
    });
    this.#cookie(res, id, 600);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: `${this.origin}/auth/google/callback`,
      response_type: "code",
      scope: `openid email ${READ_SCOPE}`,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      access_type: "online",
      prompt: "select_account",
    }).toString();
    res.writeHead(303, { Location: url.href });
    res.end();
  }

  async #googleJSON(url, init) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw new AppError(
        502,
        "Could not reach Google. Check server connectivity and try reconnecting.",
      );
    }
    if (!response.ok) {
      if (response.status === 401)
        throw new AppError(
          401,
          "Google access has expired or was revoked. Please reconnect Gmail.",
        );
      if (response.status === 403)
        throw new AppError(
          403,
          "Google denied access. Check that Gmail API is enabled and the account has granted the read-only scope.",
        );
      throw new AppError(
        502,
        "Google could not complete the request. Check your OAuth settings or try again later.",
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AppError(
        502,
        "Google returned an unexpected response. Please reconnect and try again.",
      );
    }
  }

  async callback(req, res, url) {
    if (!this.configured)
      throw new AppError(503, "Gmail sign-in is not configured.");
    const session = this.#session(req);
    const state = url.searchParams.get("state") || "";
    if (
      !session?.state ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      state.length !== session.state.length ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(session.state))
    ) {
      throw new AppError(
        400,
        "Sign-in expired or its security check failed. Start Connect Gmail again.",
      );
    }
    // Consume state once, including denied and unsuccessful attempts.
    this.sessions.delete(session.id);
    this.#cookie(res, "", 0);
    if (url.searchParams.has("error")) {
      res.writeHead(303, { Location: "/?gmail_error=cancelled" });
      return res.end();
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 4096)
      throw new AppError(
        400,
        "Google did not return a valid authorization code.",
      );
    const token = await this.#googleJSON(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: `${this.origin}/auth/google/callback`,
          grant_type: "authorization_code",
          code_verifier: session.verifier,
        }).toString(),
      },
    );
    if (
      typeof token.access_token !== "string" ||
      token.token_type?.toLowerCase() !== "bearer" ||
      typeof token.scope !== "string" ||
      !token.scope.split(" ").includes(READ_SCOPE) ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0
    ) {
      throw new AppError(
        502,
        "Google did not grant a valid read-only Gmail token. Please reconnect.",
      );
    }
    const profile = await this.#googleJSON(
      "https://openidconnect.googleapis.com/v1/userinfo",
      {
        headers: { Authorization: `Bearer ${token.access_token}` },
      },
    );
    if (
      profile.email_verified !== true ||
      typeof profile.email !== "string" ||
      profile.email.toLowerCase() !== this.allowedEmail
    ) {
      throw new AppError(
        403,
        "This private installation only allows the Gmail account configured by its owner.",
      );
    }
    this.#prune();
    const id = random();
    const seconds = Math.max(1, Math.min(Math.floor(token.expires_in), 3600));
    this.sessions.set(id, {
      email: profile.email,
      accessToken: token.access_token,
      expires: this.now() + seconds * 1000,
    });
    this.#cookie(res, id, seconds);
    res.writeHead(303, { Location: "/" });
    res.end();
  }

  async disconnect(req, res) {
    const session = this.#session(req);
    if (session) this.sessions.delete(session.id);
    this.#cookie(res, "", 0);
    // A local disconnect discards the token immediately. Google permissions can
    // also be revoked in the user's Google Account connections page.
    return { connected: false };
  }

  async #gmail(req, path) {
    const session = this.requireSession(req);
    try {
      return await this.#googleJSON(
        `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
        {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        },
      );
    } catch (error) {
      if (error.status === 401) this.sessions.delete(session.id);
      throw error;
    }
  }

  async list(req) {
    const data = await this.#gmail(
      req,
      "messages?maxResults=10&labelIds=INBOX",
    );
    if (data.messages !== undefined && !Array.isArray(data.messages))
      throw new AppError(502, "Google returned an unexpected inbox response.");
    const messages = [];
    // Keep API concurrency small for this personal app.
    const items = (data.messages || []).slice(0, 10);
    for (let i = 0; i < items.length; i += 3) {
      messages.push(
        ...(await Promise.all(
          items.slice(i, i + 3).map(async (item) => {
            if (
              typeof item.id !== "string" ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)
            )
              throw new AppError(
                502,
                "Google returned an invalid message reference.",
              );
            const message = await this.#gmail(
              req,
              `messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
            );
            return metadata(message, item.id);
          }),
        )),
      );
    }
    return { messages };
  }

  async read(req, id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw new AppError(400, "Invalid Gmail message identifier.");
    const message = await this.#gmail(
      req,
      `messages/${encodeURIComponent(id)}?format=full`,
    );
    const text = plainText(message.payload);
    const unsupported = !text;
    return {
      ...metadata(message, id),
      body: text.slice(0, 12000),
      truncated: text.length > 12000,
      unsupported,
    };
  }
}

function metadata(message, id) {
  const headers = Array.isArray(message.payload?.headers)
    ? message.payload.headers
    : [];
  const header = (name) => {
    const value = headers.find((h) => h.name?.toLowerCase() === name)?.value;
    return typeof value === "string" ? value : "";
  };
  return {
    id,
    from: header("from").slice(0, 200),
    subject: header("subject").slice(0, 200) || "(No subject)",
    date: header("date").slice(0, 100),
  };
}

function plainText(part, depth = 0) {
  if (!part || depth > 15 || part.filename) return "";
  if (part.mimeType === "text/plain" && typeof part.body?.data === "string") {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  // Never render raw HTML, remote images, or attachment contents.
  for (const child of Array.isArray(part.parts) ? part.parts : []) {
    const text = plainText(child, depth + 1);
    if (text) return text;
  }
  return "";
}
