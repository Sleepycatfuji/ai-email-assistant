import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createApp } from "../server.js";
import { demoAnalysis } from "../assistant.js";

const scope = "https://www.googleapis.com/auth/gmail.readonly";
const owner = "owner@gmail.com";
const settings = {
  clientId: "test-client",
  clientSecret: "test-secret",
  allowedEmail: owner,
  origin: "https://mail.example.com",
};
const message = {
  id: "msg123",
  payload: {
    headers: [
      { name: "From", value: "Alex <alex@example.com>" },
      { name: "Subject", value: "Project update" },
    ],
    mimeType: "multipart/alternative",
    parts: [
      {
        mimeType: "text/html",
        body: {
          data: Buffer.from(
            '<img src="https://tracker.example/pixel">',
          ).toString("base64url"),
        },
      },
      {
        mimeType: "text/plain",
        body: {
          data: Buffer.from("Please review the project by Friday.").toString(
            "base64url",
          ),
        },
      },
    ],
  },
};

function googleMock(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json(
        overrides.token || {
          access_token: "test-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope,
        },
      );
    if (url === "https://openidconnect.googleapis.com/v1/userinfo")
      return Response.json(
        overrides.profile || { email: owner, email_verified: true },
      );
    if (url.startsWith("https://gmail.googleapis.com/")) {
      assert.equal(init.headers.Authorization, "Bearer test-access-token");
      if (overrides.gmailStatus)
        return new Response("private upstream detail", {
          status: overrides.gmailStatus,
        });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/messages"))
        return Response.json(
          overrides.list || { messages: [{ id: "msg123" }] },
        );
      return Response.json(overrides.message || message);
    }
    if (url === "https://api.openai.com/v1/chat/completions") {
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify(
                demoAnalysis({
                  body: "Please review the project.",
                  subject: "Project",
                  from: "Alex",
                  tone: "professional",
                }),
              ),
            },
          },
        ],
      });
    }
    throw new Error("Unexpected request destination");
  };
  return { fetchImpl, calls };
}

async function withServer(options, run) {
  const server = createApp({
    apiKey: "",
    gmailOptions: settings,
    production: true,
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function cookie(response) {
  return response.headers.get("set-cookie")?.split(";")[0];
}

async function begin(base) {
  const response = await fetch(base + "/auth/google/start", {
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  return {
    response,
    url: new URL(response.headers.get("location")),
    cookie: cookie(response),
  };
}

async function finish(
  base,
  attempt,
  state = attempt.url.searchParams.get("state"),
) {
  return fetch(
    `${base}/auth/google/callback?${new URLSearchParams({ code: "test-code", state })}`,
    {
      headers: { Cookie: attempt.cookie },
      redirect: "manual",
    },
  );
}

async function connect(base) {
  const result = await finish(base, await begin(base));
  assert.equal(result.status, 303);
  assert.equal(result.headers.get("location"), "/");
  return cookie(result);
}

test("unconfigured Gmail is unavailable and never initiates Google requests", async () => {
  await withServer(
    {
      gmailOptions: {
        clientId: "",
        clientSecret: "",
        allowedEmail: "",
        origin: undefined,
      },
      fetchImpl() {
        throw new Error("No network expected");
      },
    },
    async (base) => {
      const status = await (await fetch(base + "/api/gmail/status")).json();
      assert.deepEqual(status, {
        configured: false,
        connected: false,
        email: null,
      });
      assert.equal((await fetch(base + "/auth/google/start")).status, 503);
      assert.equal((await fetch(base + "/api/gmail/messages")).status, 401);
    },
  );
});

test("OAuth uses read-only scope, state, PKCE, exact callback, and secure cookies", async () => {
  const mock = googleMock();
  await withServer(mock, async (base) => {
    const attempt = await begin(base);
    assert.equal(attempt.url.origin, "https://accounts.google.com");
    assert.equal(
      attempt.url.searchParams.get("redirect_uri"),
      "https://mail.example.com/auth/google/callback",
    );
    assert.equal(attempt.url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(attempt.url.searchParams.get("access_type"), "online");
    const scopes = attempt.url.searchParams.get("scope").split(" ");
    assert.deepEqual(scopes, ["openid", "email", scope]);
    assert.ok(!scopes.some((s) => /send|modify|compose/.test(s)));
    const setCookie = attempt.response.headers.get("set-cookie");
    for (const flag of [
      "__Host-mailroom=",
      "HttpOnly",
      "SameSite=Lax",
      "Secure",
      "Path=/",
    ])
      assert.ok(setCookie.includes(flag));
    const result = await finish(base, attempt);
    assert.equal(result.status, 303);
    assert.notEqual(
      cookie(result),
      attempt.cookie,
      "Session must rotate after sign-in",
    );
    const form = new URLSearchParams(mock.calls[0].init.body);
    assert.equal(
      createHash("sha256")
        .update(form.get("code_verifier"))
        .digest("base64url"),
      attempt.url.searchParams.get("code_challenge"),
    );
    assert.equal(form.get("client_secret"), "test-secret");
    assert.equal(
      (
        await (
          await fetch(base + "/api/gmail/status", {
            headers: { Cookie: cookie(result) },
          })
        ).json()
      ).email,
      owner,
    );
    assert.equal(
      (await (await fetch(base + "/api/gmail/status")).json()).email,
      null,
    );
  });
});

test("OAuth rejects wrong or missing state and callback replay without exchanging a token", async () => {
  const mock = googleMock();
  await withServer(mock, async (base) => {
    const attempt = await begin(base);
    assert.equal((await finish(base, attempt, "x".repeat(43))).status, 400);
    assert.equal((await finish(base, attempt, "界".repeat(43))).status, 400);
    assert.equal(
      (await fetch(base + "/auth/google/callback?code=fake&state=fake")).status,
      400,
    );
    assert.equal(mock.calls.length, 0);
    assert.equal((await finish(base, attempt)).status, 303);
    const calls = mock.calls.length;
    assert.equal((await finish(base, attempt)).status, 400);
    assert.equal(mock.calls.length, calls);
  });
});

test("OAuth denial consumes state and returns safely to the app", async () => {
  const mock = googleMock();
  await withServer(mock, async (base) => {
    const attempt = await begin(base);
    const response = await fetch(
      `${base}/auth/google/callback?${new URLSearchParams({ error: "access_denied", state: attempt.url.searchParams.get("state") })}`,
      { headers: { Cookie: attempt.cookie }, redirect: "manual" },
    );
    assert.equal(response.headers.get("location"), "/?gmail_error=cancelled");
    assert.equal(mock.calls.length, 0);
    assert.equal((await finish(base, attempt)).status, 400);
  });
});

test("only the configured, verified owner can connect", async () => {
  for (const profile of [
    { email: "someone-else@gmail.com", email_verified: true },
    { email: owner, email_verified: false },
  ]) {
    const mock = googleMock({ profile });
    await withServer(mock, async (base) => {
      const result = await finish(base, await begin(base));
      assert.equal(result.status, 403);
      assert.equal(
        (
          await (
            await fetch(base + "/api/gmail/status", {
              headers: { Cookie: cookie(result) || "" },
            })
          ).json()
        ).connected,
        false,
      );
    });
  }
});

test("missing Gmail scope or malformed tokens cannot create a session", async () => {
  for (const token of [
    {
      access_token: "test",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email",
    },
    { access_token: "test", token_type: "Bearer", expires_in: -1, scope },
    { scope },
  ]) {
    await withServer(googleMock({ token }), async (base) => {
      assert.equal((await finish(base, await begin(base))).status, 502);
    });
  }
});

test("authenticated inbox reads plain text without loading images or modifying messages", async () => {
  const mock = googleMock();
  await withServer(mock, async (base) => {
    const session = await connect(base);
    const headers = { Cookie: session };
    const list = await (
      await fetch(base + "/api/gmail/messages", { headers })
    ).json();
    assert.equal(list.messages.length, 1);
    assert.equal(list.messages[0].subject, "Project update");
    assert.ok(!JSON.stringify(list).includes("test-access-token"));
    const email = await (
      await fetch(base + "/api/gmail/messages/msg123", { headers })
    ).json();
    assert.equal(email.body, "Please review the project by Friday.");
    assert.equal(email.truncated, false);
    assert.equal(email.unsupported, false);
    assert.ok(!mock.calls.some((c) => c.url.includes("tracker.example")));
    assert.ok(
      mock.calls
        .filter((c) => c.url.includes("gmail.googleapis.com"))
        .every((c) => !c.init.method || c.init.method === "GET"),
    );
    assert.equal(
      (await fetch(base + "/api/gmail/messages/bad%20id", { headers })).status,
      400,
    );
  });
});

test("HTML-only messages and attachments are not rendered, long text is explicitly truncated", async () => {
  for (const [payload, expected] of [
    [
      {
        mimeType: "text/html",
        body: {
          data: Buffer.from("<script>alert(1)</script>").toString("base64url"),
        },
      },
      { unsupported: true, truncated: false, length: 0 },
    ],
    [
      {
        mimeType: "text/plain",
        filename: "attachment.txt",
        body: { data: Buffer.from("attachment").toString("base64url") },
      },
      { unsupported: true, truncated: false, length: 0 },
    ],
    [
      {
        mimeType: "text/plain",
        body: { data: Buffer.from("a".repeat(13000)).toString("base64url") },
      },
      { unsupported: false, truncated: true, length: 12000 },
    ],
  ]) {
    await withServer(
      googleMock({ message: { ...message, payload } }),
      async (base) => {
        const session = await connect(base);
        const data = await (
          await fetch(base + "/api/gmail/messages/msg123", {
            headers: { Cookie: session },
          })
        ).json();
        assert.equal(data.unsupported, expected.unsupported);
        assert.equal(data.truncated, expected.truncated);
        assert.equal(data.body.length, expected.length);
      },
    );
  }
});

test("disconnect invalidates the session and rejects cross-site POSTs", async () => {
  await withServer(googleMock(), async (base) => {
    const session = await connect(base);
    const bad = await fetch(base + "/api/gmail/disconnect", {
      method: "POST",
      headers: { Cookie: session, Origin: "https://evil.example" },
    });
    assert.equal(bad.status, 403);
    const result = await fetch(base + "/api/gmail/disconnect", {
      method: "POST",
      headers: { Cookie: session, Origin: settings.origin },
    });
    assert.equal(result.status, 200);
    assert.ok(result.headers.get("set-cookie").includes("Max-Age=0"));
    assert.equal(
      (
        await fetch(base + "/api/gmail/messages", {
          headers: { Cookie: session },
        })
      ).status,
      401,
    );
  });
});

test("expired login state and access sessions require reconnection", async () => {
  let time = Date.now();
  const mock = googleMock();
  await withServer(
    { ...mock, gmailOptions: { ...settings, now: () => time } },
    async (base) => {
      const attempt = await begin(base);
      time += 11 * 60000;
      assert.equal((await finish(base, attempt)).status, 400);
      assert.equal(mock.calls.length, 0);
      const session = await connect(base);
      time += 61 * 60000;
      assert.equal(
        (
          await fetch(base + "/api/gmail/messages", {
            headers: { Cookie: session },
          })
        ).status,
        401,
      );
    },
  );
});

test("revoked Google token clears the local session without exposing upstream errors", async () => {
  await withServer(googleMock({ gmailStatus: 401 }), async (base) => {
    const session = await connect(base);
    const response = await fetch(base + "/api/gmail/messages", {
      headers: { Cookie: session },
    });
    assert.equal(response.status, 401);
    assert.ok(!(await response.text()).includes("private upstream detail"));
    assert.equal(
      (
        await (
          await fetch(base + "/api/gmail/status", {
            headers: { Cookie: session },
          })
        ).json()
      ).connected,
      false,
    );
  });
});

test("public hosted live AI is blocked without owner login; demo stays available", async () => {
  const body = JSON.stringify({
    body: "Please review the project.",
    mode: "auto",
  });
  await withServer({ ...googleMock(), apiKey: "test-only" }, async (base) => {
    const request = (headers) =>
      fetch(base + "/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });
    assert.equal((await request({})).status, 401);
    const session = await connect(base);
    assert.equal((await request({ Cookie: session })).status, 200);
    const demo = await fetch(base + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Sample email", mode: "demo" }),
    });
    assert.equal(demo.status, 200);
  });
  await withServer(
    {
      production: true,
      apiKey: "test-only",
      gmailOptions: { clientId: "", clientSecret: "", allowedEmail: "" },
    },
    async (base) => {
      assert.equal(
        (
          await fetch(base + "/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          })
        ).status,
        503,
      );
    },
  );
});

test("unsafe application origins are rejected before serving requests", () => {
  for (const origin of [
    "http://mail.example.com",
    "https://mail.example.com/path",
    "https://user:pass@mail.example.com",
    "https://mail.example.com?x=1",
    "https://mail.example.com#x",
  ]) {
    assert.throws(() =>
      createApp({ production: true, gmailOptions: { ...settings, origin } }),
    );
  }
});
