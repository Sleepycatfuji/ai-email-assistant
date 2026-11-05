const $ = (id) => document.getElementById(id);
const samples = [
  {
    id: "project",
    initials: "JL",
    name: "Jamie Lee",
    address: "jamie@example.com",
    label: "Project feedback",
    subject: "A fresh look at the launch plan",
    body: "Hi there,\n\nWe’ve put together the first draft of the spring launch plan, and I’d love your perspective before we share it with the wider team.\n\nCould you review the proposed timeline and share any feedback by Friday? In particular, please take a look at whether we’ve left enough time for testing.\n\nNo need for a detailed write-up — a few thoughts would be really helpful.\n\nThanks,\nJamie",
  },
  {
    id: "meeting",
    initials: "AM",
    name: "Alex Morgan",
    address: "alex@example.com",
    label: "Meeting request",
    subject: "Time for a quick catch-up?",
    body: "Hello,\n\nIt would be great to catch up on the website project this week. We have a few design decisions to talk through before the next stage.\n\nCould you let me know if Tuesday at 10am or Thursday at 2pm works for a 30-minute call? If neither works, please suggest another time.\n\nI’ll send a calendar invitation once we find a slot.\n\nBest,\nAlex",
  },
  {
    id: "invoice",
    initials: "SP",
    name: "Sam Patel",
    address: "sam@example.com",
    label: "Payment reminder",
    subject: "Invoice #1042 — a quick reminder",
    body: "Hi there,\n\nJust a friendly reminder that invoice #1042 for the November design work is due by tomorrow. The total is €480.\n\nPlease check whether the payment has been scheduled, and let me know if you need a copy of the invoice.\n\nIf you’ve already paid, please share the payment reference so I can update our records.\n\nMany thanks,\nSam",
  },
];

let source = "sample";
let selected = samples[0];
let result = null;
let controller = null;
let generation = 0;
let busy = false;
let serverMode = "demo";
let connected = false;
let resultEmail = null;
let draftBaseline = "";
let toastTimer;
let gmailAccount = { configured: false, connected: false, email: null };
let selectedGmail = null;
let gmailGeneration = 0;
let gmailReadController = null;

function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 4000);
}

function setBusy(value) {
  busy = value;
  $("assistant-panel").setAttribute("aria-busy", String(value));
  $("analyze-button").disabled = value;
  $("analyze-label").textContent = value ? "Working on it…" : "Analyze email";
  const stale =
    resultEmail &&
    JSON.stringify(currentEmail()) !== JSON.stringify(resultEmail);
  $("regenerate-button").disabled = value || Boolean(stale);
  $("regenerate-button").title = stale
    ? "Analyze the updated email first."
    : "Replace your draft using the selected tone";
  $("reply-tone").disabled = value;
  $("loading-state").hidden = !value;
}

function resetResult() {
  generation++;
  controller?.abort();
  controller = null;
  result = null;
  resultEmail = null;
  setBusy(false);
  $("analysis-result").hidden = true;
  $("assistant-error").hidden = true;
  $("empty-state").hidden = false;
  $("reply-body").value = "";
  $("reply-subject").value = "";
}

function confirmDiscard() {
  return (
    !result ||
    `${$("reply-subject").value}\n${$("reply-body").value}` === draftBaseline ||
    window.confirm("You’ve edited this draft. Discard your changes?")
  );
}

function selectSample(sample, { initial = false } = {}) {
  if (!initial && !confirmDiscard()) return;
  selected = sample;
  document.querySelectorAll(".sample-card").forEach((button) => {
    const active = button.dataset.id === sample.id;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
    button.querySelector(".sample-marker").textContent = active ? "●" : "○";
  });
  $("sender-avatar").textContent = sample.initials;
  $("preview-from").textContent = sample.name;
  $("preview-address").textContent = sample.address;
  $("preview-subject").textContent = sample.subject;
  $("preview-body").textContent = sample.body;
  resetResult();
}

function setSource(next) {
  if (source === next) return;
  if (next === "gmail" && !gmailAccount.connected) {
    toast(
      "Use Connect Gmail first. If setup is needed, follow the deployment guide.",
    );
    return;
  }
  if (!confirmDiscard()) return;
  source = next;
  for (const id of ["sample", "paste", "gmail"]) {
    const active = id === next;
    $(`${id}-view`).hidden = !active;
    $(`${id}-tab`).setAttribute("aria-selected", String(active));
    $(`${id}-tab`).tabIndex = active ? 0 : -1;
  }
  $("samples-nav").classList.toggle("active", next === "sample");
  $("paste-nav").classList.toggle("active", next === "paste");
  $("gmail-nav").classList.toggle("active", next === "gmail");
  resetResult();
  if (next === "gmail") loadInbox();
}

function currentEmail() {
  if (source === "gmail")
    return {
      from: selectedGmail?.from || "",
      subject: selectedGmail?.subject || "",
      body: selectedGmail?.body || "",
    };
  return source === "sample"
    ? {
        from: `${selected.name} <${selected.address}>`,
        subject: selected.subject,
        body: selected.body,
      }
    : {
        from: $("email-from").value.trim(),
        subject: $("email-subject").value.trim(),
        body: $("email-body").value.trim(),
      };
}

function showError(message, fallback = false) {
  $("error-text").textContent = message;
  $("assistant-error").hidden = false;
  $("fallback-button").hidden = !fallback;
}

function renderResult(data) {
  result = data;
  $("empty-state").hidden = true;
  $("analysis-result").hidden = false;
  $("result-mode").textContent =
    data.mode === "demo" ? "DEMO SUGGESTION" : "AI SUGGESTION";
  $("category-tag").textContent = data.category;
  $("priority-tag").textContent = `${data.priority} priority`;
  $("priority-tag").className = `priority-${data.priority.toLowerCase()}`;
  $("summary-text").textContent = data.summary;
  $("deadline").hidden = !data.deadline;
  $("deadline").textContent = data.deadline
    ? `Mentioned deadline: ${data.deadline}`
    : "";
  $("action-list").replaceChildren(
    ...data.actions.map((action) => {
      const li = document.createElement("li");
      li.textContent = action;
      return li;
    }),
  );
  $("action-count").textContent =
    `${data.actions.length} ${data.actions.length === 1 ? "item" : "items"}`;
  $("no-actions").hidden = data.actions.length > 0;
  $("reply-subject").value = data.replySubject;
  $("reply-body").value = data.reply;
  draftBaseline = `${data.replySubject}\n${data.reply}`;
}

async function analyzeEmail({ mode = "auto", regenerate = false } = {}) {
  if (busy || !confirmDiscard()) return;
  const email = regenerate && resultEmail ? resultEmail : currentEmail();
  if (!email.body) {
    showError(
      source === "gmail"
        ? "Select a Gmail message with a plain-text body first."
        : "Paste an email message first.",
    );
    if (source !== "gmail") $("email-body").focus();
    return;
  }
  $("assistant-error").hidden = true;
  $("empty-state").hidden = true;
  $("analysis-result").hidden = true;
  const requestGeneration = ++generation;
  controller?.abort();
  controller = new AbortController();
  setBusy(true);
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...email, tone: $("reply-tone").value, mode }),
      signal: controller.signal,
    });
    const data = await response.json();
    if (requestGeneration !== generation) return;
    if (!response.ok)
      throw new Error(
        data.error || "The assistant could not complete that request.",
      );
    resultEmail = email;
    renderResult(data);
    if (window.matchMedia("(max-width: 650px)").matches) {
      $("assistant-panel").scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "start",
      });
    }
  } catch (error) {
    if (error.name === "AbortError" || requestGeneration !== generation) return;
    showError(
      error instanceof TypeError
        ? "Could not reach the server. Check that npm start is still running."
        : error.message,
      connected && serverMode === "live" && mode !== "demo",
    );
    $("analysis-result").hidden = !result;
    $("empty-state").hidden = Boolean(result);
  } finally {
    if (requestGeneration === generation) {
      controller = null;
      setBusy(false);
    }
  }
}

for (const sample of samples) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sample-card";
  button.dataset.id = sample.id;
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = sample.initials;
  const info = document.createElement("span");
  info.className = "sample-info";
  const title = document.createElement("strong");
  title.textContent = sample.subject;
  const sub = document.createElement("small");
  sub.textContent = `${sample.name} · ${sample.label}`;
  info.append(title, sub);
  const marker = document.createElement("span");
  marker.className = "sample-marker";
  marker.setAttribute("aria-hidden", "true");
  button.append(avatar, info, marker);
  button.addEventListener("click", () => selectSample(sample));
  $("sample-list").append(button);
}
selectSample(selected, { initial: true });

$("sample-tab").addEventListener("click", () => setSource("sample"));
$("paste-tab").addEventListener("click", () => setSource("paste"));
$("gmail-tab").addEventListener("click", () => setSource("gmail"));
$("gmail-nav").addEventListener("click", () => setSource("gmail"));
$("samples-nav").addEventListener("click", () => setSource("sample"));
$("paste-nav").addEventListener("click", () => {
  setSource("paste");
  if (source === "paste") $("email-from").focus();
});
for (const tab of [$("sample-tab"), $("paste-tab"), $("gmail-tab")]) {
  tab.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const available = gmailAccount.connected
        ? ["sample", "paste", "gmail"]
        : ["sample", "paste"];
      const index = available.indexOf(source);
      const next =
        event.key === "Home"
          ? available[0]
          : event.key === "End"
            ? available.at(-1)
            : available[
                (index +
                  (event.key === "ArrowLeft" ? -1 : 1) +
                  available.length) %
                  available.length
              ];
      setSource(next);
      $(`${source}-tab`).focus();
    }
  });
}
for (const field of ["email-from", "email-subject", "email-body"]) {
  $(field).addEventListener("input", () => {
    if (busy) resetResult();
    if (result) {
      $("analyze-label").textContent = "Analyze updated email";
      $("regenerate-button").disabled = true;
      $("regenerate-button").title = "Analyze the updated email first.";
    }
    $("body-count").textContent =
      `${$("email-body").value.length.toLocaleString("en-US")} / 12,000 characters`;
  });
}
$("analyze-button").addEventListener("click", () => analyzeEmail());
$("regenerate-button").addEventListener("click", () =>
  analyzeEmail({ mode: result?.mode || "auto", regenerate: true }),
);
$("fallback-button").addEventListener("click", () =>
  analyzeEmail({ mode: "demo" }),
);

$("copy-button").addEventListener("click", async () => {
  try {
    if (!navigator.clipboard?.writeText)
      throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText($("reply-body").value);
    toast("Reply copied. Review it before sending.");
  } catch {
    $("reply-body").focus();
    $("reply-body").select();
    toast(
      "Clipboard unavailable. Your reply is selected; use your device’s copy command.",
    );
  }
});
$("download-button").addEventListener("click", () => {
  const text = `Subject: ${$("reply-subject").value}\n\n${$("reply-body").value}\n`;
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "mailroom-reply.txt";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Reply downloaded as a text file.");
});
$("how-button").addEventListener("click", () => $("help-dialog").showModal());
$("close-help").addEventListener("click", () => $("help-dialog").close());
$("help-dialog").addEventListener("click", (event) => {
  const bounds = $("help-dialog").getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    $("help-dialog").close();
});
window.addEventListener("beforeunload", (event) => {
  if (
    result &&
    `${$("reply-subject").value}\n${$("reply-body").value}` !== draftBaseline
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});

function renderGmailAccount() {
  $("gmail-connection-status").textContent = gmailAccount.connected
    ? `Connected as ${gmailAccount.email}. Sessions last up to one hour.`
    : gmailAccount.configured
      ? "Connect your configured Google account to try your own emails."
      : "Gmail setup is needed on the server. The samples and paste tools work now.";
  $("gmail-connect").hidden = gmailAccount.connected;
  $("gmail-disconnect").hidden = !gmailAccount.connected;
  $("gmail-tab").setAttribute("aria-disabled", String(!gmailAccount.connected));
}

function clearImportedEmail() {
  gmailGeneration++;
  gmailReadController?.abort();
  selectedGmail = null;
  $("gmail-message-list").replaceChildren();
  $("gmail-preview").hidden = true;
  for (const id of [
    "gmail-preview-from",
    "gmail-preview-subject",
    "gmail-preview-body",
    "gmail-truncated",
    "summary-text",
    "deadline",
    "action-list",
  ])
    $(id).textContent = "";
  resetResult();
  if (source === "gmail") setSource("sample");
}

async function gmailRequest(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      gmailAccount = { ...gmailAccount, connected: false, email: null };
      clearImportedEmail();
      renderGmailAccount();
    }
    throw new Error(
      data.error || "Could not load Gmail. Please try reconnecting.",
    );
  }
  return data;
}

async function loadInbox() {
  const current = ++gmailGeneration;
  $("gmail-inbox-status").textContent = "Loading your recent inbox messages…";
  $("gmail-refresh").disabled = true;
  try {
    const data = await gmailRequest("/api/gmail/messages");
    if (current !== gmailGeneration || source !== "gmail") return;
    $("gmail-message-list").replaceChildren(
      ...data.messages.map((message) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "sample-card";
        const info = document.createElement("span");
        info.className = "sample-info";
        const title = document.createElement("strong");
        title.textContent = message.subject;
        const sender = document.createElement("small");
        sender.textContent = message.from;
        info.append(title, sender);
        button.append(info);
        button.addEventListener("click", () => loadGmailMessage(message.id));
        return button;
      }),
    );
    $("gmail-inbox-status").textContent = data.messages.length
      ? "Choose a message to preview it. No read status will be changed."
      : "Your inbox has no messages.";
  } catch (error) {
    if (current === gmailGeneration)
      $("gmail-inbox-status").textContent = error.message;
    else if (!gmailAccount.connected) toast(error.message);
  } finally {
    $("gmail-refresh").disabled = false;
  }
}

async function loadGmailMessage(id) {
  if (!confirmDiscard()) return;
  const current = ++gmailGeneration;
  gmailReadController?.abort();
  gmailReadController = new AbortController();
  selectedGmail = null;
  resetResult();
  $("gmail-preview").hidden = true;
  $("gmail-inbox-status").textContent = "Loading the selected email…";
  try {
    const message = await gmailRequest(
      `/api/gmail/messages/${encodeURIComponent(id)}`,
      { signal: gmailReadController.signal },
    );
    if (current !== gmailGeneration || source !== "gmail") return;
    selectedGmail = message;
    $("gmail-preview-from").textContent = message.from;
    $("gmail-preview-subject").textContent = message.subject;
    $("gmail-preview-body").textContent = message.body;
    $("gmail-truncated").hidden = !message.truncated;
    $("gmail-truncated").textContent =
      "Showing and analyzing only the first 12,000 characters.";
    $("gmail-preview").hidden = false;
    $("gmail-inbox-status").textContent = message.unsupported
      ? "This message has no supported plain-text body. HTML-only messages and attachments are not loaded."
      : "Email loaded. Click Analyze when you’re ready.";
  } catch (error) {
    if (error.name === "AbortError") return;
    if (current === gmailGeneration)
      $("gmail-inbox-status").textContent = error.message;
    else if (!gmailAccount.connected) toast(error.message);
  }
}

$("gmail-connect").addEventListener("click", () => {
  if (!gmailAccount.configured)
    return toast(
      "Set up Google OAuth on the server first. See DEPLOYMENT.md in the source download.",
    );
  if (confirmDiscard()) window.location.assign("/auth/google/start");
});
$("gmail-refresh").addEventListener("click", loadInbox);
$("gmail-disconnect").addEventListener("click", async () => {
  if (!confirmDiscard()) return;
  $("gmail-disconnect").disabled = true;
  try {
    await gmailRequest("/api/gmail/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    gmailAccount = { ...gmailAccount, connected: false, email: null };
    clearImportedEmail();
    renderGmailAccount();
    toast(
      "Disconnected. To remove Google permission too, use your Google Account’s third-party connections settings.",
    );
  } catch (error) {
    toast(error.message);
  } finally {
    $("gmail-disconnect").disabled = false;
  }
});

try {
  gmailAccount = await gmailRequest("/api/gmail/status");
} catch {
  gmailAccount = { configured: false, connected: false, email: null };
}
renderGmailAccount();
if (new URLSearchParams(location.search).has("gmail_error")) {
  toast("Gmail sign-in was cancelled. You can try connecting again.");
  history.replaceState(null, "", location.pathname);
}

try {
  const response = await fetch("/api/status");
  if (!response.ok) throw new Error("Unavailable");
  const data = await response.json();
  connected = true;
  serverMode = data.mode;
  const live = data.mode === "live";
  $("mode-label").textContent = live ? "Live AI configured" : "Offline demo";
  $("mode-pill").classList.toggle("live", live);
  $("mode-description").textContent = live
    ? "Live AI is configured. Clicking Analyze sends the selected email to OpenAI. Review every suggestion."
    : "Take it for a spin. Demo mode uses simple rules and reply templates. No account or API key needed.";
  $("privacy-note").textContent = live
    ? "Analysis sends the email text to OpenAI. Nothing is sent to a recipient."
    : "Demo processing stays on this machine. Nothing is sent to an AI provider.";
} catch {
  $("mode-label").textContent = "Server unavailable";
  $("mode-description").textContent =
    "Could not reach the server. Start it with npm start and reload this page.";
}
