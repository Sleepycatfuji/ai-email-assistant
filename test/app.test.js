import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server.js";
import { analyze, demoAnalysis, validateInput } from "../assistant.js";

const email = {
  from: "Alex Morgan <alex@example.com>",
  subject: "Project feedback",
  body: "Hi there,\n\nPlease review the launch plan by Friday. Could you share feedback on the testing timeline?\n\nThanks,\nAlex",
  tone: "professional",
  mode: "demo",
};

async function withServer(options, run) {
  const server = createApp({ apiKey: "", ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(base, body, headers = {}) {
  return fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("demo extracts relevant actions, category, deadline, and editable reply", () => {
  const result = demoAnalysis(email);
  assert.equal(result.category, "Project");
  assert.equal(result.priority, "Normal");
  assert.equal(result.deadline, "by Friday");
  assert.equal(result.actions.length, 2);
  assert.match(result.summary, /launch plan/);
  assert.match(result.reply, /^Hi Alex,/);
  assert.match(result.reply, /\[Your name\]/);
  assert.equal(result.replySubject, "Re: Project feedback");
});

test("demo distinguishes urgent finance and non-actionable newsletter", () => {
  const finance = demoAnalysis({
    ...email,
    subject: "Invoice",
    body: "Please check the payment by tomorrow.",
  });
  assert.equal(finance.category, "Finance");
  assert.equal(finance.priority, "High");
  const newsletter = demoAnalysis({
    ...email,
    subject: "Newsletter",
    body: "Our new collection is here. No reply needed.",
  });
  assert.equal(newsletter.priority, "Low");
  assert.deepEqual(newsletter.actions, []);
  assert.equal(newsletter.deadline, null);
});

test("tones affect the draft and repeated Re prefixes are normalized", () => {
  const friendly = demoAnalysis({
    ...email,
    tone: "friendly",
    subject: "Re: Re: Hello",
  });
  assert.match(friendly.reply, /Thanks so much/);
  assert.equal(friendly.replySubject, "Re: Hello");
  assert.notEqual(
    friendly.reply,
    demoAnalysis({ ...email, tone: "concise" }).reply,
  );
});

test("input validation rejects malformed values, invalid options, and oversized emails", () => {
  for (const input of [
    null,
    [],
    {},
    { body: " " },
    { body: 12 },
    { body: "x", from: {} },
    { body: "x", tone: "angry" },
    { body: "x", mode: "unknown" },
    { body: "x".repeat(12001) },
    { body: "x", subject: "s".repeat(201) },
  ]) {
    assert.throws(
      () => validateInput(input),
      (error) => error.status === 400,
    );
  }
  assert.equal(validateInput({ body: " hello " }).body, "hello");
});

test("offline mode does not call an external service even when a key exists", async () => {
  const result = await analyze(email, {
    apiKey: "test-only",
    fetchImpl() {
      throw new Error("Must not call");
    },
  });
  assert.equal(result.mode, "demo");
});

test("live mode requires a configured key", async () => {
  await assert.rejects(
    analyze({ ...email, mode: "live" }, {}),
    (error) => error.status === 503,
  );
});

test("live provider request uses server credentials and validates the structured response", async () => {
  let called = false;
  const result = await analyze(
    { ...email, mode: "live" },
    {
      apiKey: "test-only",
      model: "test-model",
      fetchImpl: async (url, init) => {
        called = true;
        assert.equal(url, "https://api.openai.com/v1/chat/completions");
        assert.equal(init.headers.Authorization, "Bearer test-only");
        const payload = JSON.parse(init.body);
        assert.equal(payload.model, "test-model");
        assert.equal(
          JSON.parse(payload.messages[1].content).email.body,
          email.body,
        );
        return Response.json({
          choices: [
            { message: { content: JSON.stringify(demoAnalysis(email)) } },
          ],
        });
      },
    },
  );
  assert.ok(called);
  assert.equal(result.mode, "live");
  assert.equal(result.category, "Project");
});

test("live service errors are actionable and never expose upstream secrets", async () => {
  for (const status of [401, 429, 500]) {
    await assert.rejects(
      analyze(
        { ...email, mode: "live" },
        {
          apiKey: "secret-test-value",
          fetchImpl: async () =>
            new Response("sensitive upstream body", { status }),
        },
      ),
      (error) =>
        error.status === 502 &&
        !/sensitive|secret-test-value/.test(error.message),
    );
  }
  await assert.rejects(
    analyze(
      { ...email, mode: "live" },
      {
        apiKey: "test-only",
        fetchImpl: async () => {
          throw new Error("private network detail");
        },
      },
    ),
    /Could not reach/,
  );
});

test("malformed or incomplete model output cannot masquerade as a successful analysis", async () => {
  for (const content of [
    "not json",
    "{}",
    JSON.stringify({ ...demoAnalysis(email), priority: "Critical" }),
    JSON.stringify({ ...demoAnalysis(email), actions: [123] }),
  ]) {
    await assert.rejects(
      analyze(
        { ...email, mode: "live" },
        {
          apiKey: "test-only",
          fetchImpl: async () =>
            Response.json({ choices: [{ message: { content } }] }),
        },
      ),
      (error) => error.status === 502,
    );
  }
});

test("HTTP app serves its interface and assets with protective headers", async () => {
  await withServer({}, async (base) => {
    for (const [path, type] of [
      ["/", "text/html"],
      ["/app.js", "text/javascript"],
      ["/style.css", "text/css"],
      ["/favicon.svg", "image/svg+xml"],
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type").startsWith(type));
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(
        response.headers.get("content-security-policy"),
        /frame-ancestors 'none'/,
      );
      assert.ok((await response.text()).length > 100);
    }
    const head = await fetch(base, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });
});

test("HTTP status identifies demo without leaking configuration and performs real analysis", async () => {
  await withServer({}, async (base) => {
    assert.deepEqual(await (await fetch(base + "/api/status")).json(), {
      status: "ok",
      mode: "demo",
      model: null,
    });
    const response = await post(base, email);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.mode, "demo");
    assert.match(data.reply, /Hi Alex/);
    assert.equal(data.actions.length, 2);
  });
});

test("HTTP rejects invalid input, invalid JSON, oversized payloads, and foreign origins", async () => {
  await withServer({}, async (base) => {
    for (const [body, headers, status] of [
      [{ body: "" }, {}, 400],
      ["{broken", {}, 400],
      [email, { "Content-Type": "text/plain" }, 415],
      [email, { Origin: "https://another.example" }, 403],
      [{ body: "a".repeat(41000) }, {}, 413],
    ]) {
      const response = await post(base, body, headers);
      assert.equal(response.status, status);
      assert.equal(typeof (await response.json()).error, "string");
    }
    assert.equal((await post(base, email, { Origin: base })).status, 200);
  });
});

test("HTTP serves only explicitly allowed assets; secrets and source stay private", async () => {
  await withServer({ apiKey: "never-return-this" }, async (base) => {
    for (const path of [
      "/.env",
      "/server.js",
      "/package.json",
      "/%2e%2e/.env",
      "/missing",
    ]) {
      assert.equal((await fetch(base + path)).status, 404);
    }
    const status = await (await fetch(base + "/api/status")).json();
    assert.equal(status.mode, "live");
    assert.ok(!JSON.stringify(status).includes("never-return-this"));
  });
});
