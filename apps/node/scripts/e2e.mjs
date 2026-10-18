#!/usr/bin/env node
// End-to-end check against a real IMAP/SMTP server (GreenMail), through the MCP HTTP endpoint.
//   docker run -d --rm --name mailmcp-greenmail -p 127.0.0.1:13025:3025 -p 127.0.0.1:13143:3143 \
//     -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled=false -Dgreenmail.users=me:pw@example.com,alice:pw@corp.com -Dgreenmail.users.login=email' \
//     greenmail/standalone:2.1.3
//   pnpm build && node apps/node/scripts/e2e.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ImapFlow } from "imapflow";

const IMAP_PORT = Number(process.env.E2E_IMAP_PORT ?? 13143);
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 13025);
const PORT = Number(process.env.E2E_PORT ?? 8797);
const TOKEN = "e2e-token";
const mailbox = (user) => ({
  imap: { host: "127.0.0.1", port: IMAP_PORT, secure: false, user, password: "pw" },
  smtp: { host: "127.0.0.1", port: SMTP_PORT, secure: false, user, password: "pw" },
});

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`);
  if (!cond) failures++;
}

async function imap(user, fn) {
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: IMAP_PORT,
    secure: false,
    auth: { user, pass: "pw" },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

async function rawMessages(user, folder) {
  return imap(user, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const out = [];
      if (!c.mailbox.exists) return out;
      for await (const m of c.fetch("1:*", { uid: true, flags: true, source: true })) {
        out.push({ uid: m.uid, flags: [...m.flags], raw: m.source.toString("utf8") });
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

export function accountsEnv() {
  return {
    MAIL_MODE: "pull_push",
    DEFAULT_EMAIL_ACCOUNT: "me",
    SEND_ALLOWLIST: "corp.com,example.com",
    EMAIL_ACCOUNTS_JSON: JSON.stringify({
      me: { ...mailbox("me@example.com"), default_from_name: "Me Tester" },
      alice: { ...mailbox("alice@corp.com"), default_from_name: "Alice" },
    }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (const user of ["me@example.com", "alice@corp.com"]) {
    await imap(user, async (c) => {
      for (const f of ["Sent", "Drafts", "Trash"]) await c.mailboxCreate(f).catch(() => {});
    });
  }

  // E2E_URL targets an already-running server (e.g. `wrangler dev` with .dev.vars from accountsEnv()).
  const external = process.env.E2E_URL;
  const BASE = external ?? `http://127.0.0.1:${PORT}`;
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const server = external ? null : spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      PORT: String(PORT),
      MCP_BEARER_TOKEN: TOKEN,
      ...accountsEnv(),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break;
      } catch {}
      await sleep(100);
    }

    const unauth = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
    check("rejects missing bearer (401)", unauth.status === 401, unauth.status);

    const client = new Client({ name: "e2e", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const call = async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content?.[0]?.text ?? "";
      if (res.isError) return { __error: text };
      return JSON.parse(text);
    };

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    check("lists 9 tools", names.length === 9, names);
    const findTool = tools.tools.find((t) => t.name === "emails_find");
    check(
      "tool schemas are typed + described",
      findTool?.inputSchema?.properties?.limit?.type === "integer" &&
        typeof findTool?.inputSchema?.properties?.cursor?.description === "string",
      findTool?.inputSchema?.properties?.limit,
    );

    // Seed: alice sends 25 messages to me (exercises email_send on a second account).
    for (let i = 1; i <= 23; i++) {
      await call("email_send", { account_name: "alice", to: ["me@example.com"], subject: `Batch ${i}`, body: `Body number ${i}` });
    }
    const att = Buffer.from("hello attachment").toString("base64");
    const planSent = await call("email_send", {
      account_name: "alice",
      to: ["Me Tester <me@example.com>"],
      cc: ["bob@corp.com"],
      subject: "Quarterly plan",
      body: "<p>Please review the <b>plan</b>.</p>",
      body_type: "html",
      attachments: [{ filename: "plan.txt", content: att, content_type: "text/plain" }],
    });
    check("send to named recipient + cc + html + attachment", planSent.sent === true, planSent);
    const lastSeed = await call("email_send", { account_name: "alice", to: ["me@example.com"], subject: "Lunch?", body: "pizza zebra" });
    check("send returns message_id + Sent copy", Boolean(lastSeed.message_id) && lastSeed.saved_to_sent === "Sent", lastSeed);
    await sleep(300);

    // Pagination
    const seen = new Set();
    let cursor;
    let pages = 0;
    let total = 0;
    do {
      const page = await call("emails_find", { limit: 10, cursor });
      total = page.total;
      page.emails.forEach((e) => seen.add(e.id));
      cursor = page.next_cursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    check("pagination covers all 25 without dupes in 3 pages", total === 25 && seen.size === 25 && pages === 3, { total, size: seen.size, pages });

    const first = await call("emails_find", { limit: 3 });
    check("newest first + snippet", first.emails[0]?.subject === "Lunch?" && first.emails[0]?.snippet?.includes("pizza"), first.emails[0]);

    const search = await call("emails_find", { query: "zebra" });
    check("full-text search", search.total === 1 && search.emails[0]?.subject === "Lunch?", search);

    const withAtt = await call("emails_find", { filters: { has_attachments: true } });
    check("has_attachments filter", withAtt.count === 1 && withAtt.emails[0]?.subject === "Quarterly plan", withAtt);
    const planId = withAtt.emails[0].id;

    // Read
    const plan = await call("email_get", { email_id: planId, include_attachment_content: true });
    check(
      "email_get: html->text, attachment, ids",
      plan.bodyText.includes("Please review the plan") &&
        plan.attachments?.[0]?.filename === "plan.txt" &&
        Buffer.from(plan.attachments[0].contentBase64, "base64").toString() === "hello attachment" &&
        plan.messageId?.startsWith("<") &&
        plan.isUnread === true,
      plan,
    );

    // Reply-all: threading, self removal, Sent copy, \Answered
    const reply = await call("email_respond", { email_id: planId, body: "Looks good to me.", reply_all: true });
    check("reply-all recipients drop self", reply.to?.[0]?.includes("alice@corp.com") && JSON.stringify(reply.cc) === JSON.stringify(["bob@corp.com"]), reply);
    check("reply saved to Sent", reply.saved_to_sent === "Sent" && reply.warnings.length === 0, reply);
    await sleep(300);
    const aliceInbox = await rawMessages("alice@corp.com", "INBOX");
    const gotReply = aliceInbox.find((m) => m.raw.includes("Subject: Re: Quarterly plan"));
    check(
      "recipient gets In-Reply-To/References = original Message-ID",
      gotReply && gotReply.raw.includes(`In-Reply-To: ${plan.messageId}`) && /References: .*</.test(gotReply.raw),
      gotReply?.raw.slice(0, 600),
    );
    check("reply quotes original", gotReply?.raw.includes("> Please review the plan"), undefined);
    const planAfter = await call("email_get", { email_id: planId });
    check("original marked \\Answered", planAfter.flags.includes("\\Answered"), planAfter.flags);

    // Forward with attachments
    const fwd = await call("email_respond", { email_id: planId, body: "FYI", forward: true, to: ["alice@corp.com"] });
    await sleep(300);
    const fwdRaw = (await rawMessages("alice@corp.com", "INBOX")).find((m) => m.raw.includes("Subject: Fwd: Quarterly plan"));
    check("forward delivered with attachment", fwd.sent && /filename="?plan\.txt/.test(fwdRaw?.raw ?? "") , fwdRaw?.raw.slice(0, 400));

    // Bcc hidden from recipients, kept in own Sent copy
    await call("email_send", { to: ["alice@corp.com"], bcc: ["me@example.com"], subject: "Secret bcc", body: "x" });
    await sleep(300);
    const bccDelivered = (await rawMessages("alice@corp.com", "INBOX")).find((m) => m.raw.includes("Subject: Secret bcc"));
    const bccSent = (await rawMessages("me@example.com", "Sent")).find((m) => m.raw.includes("Subject: Secret bcc"));
    const bccInbox = (await rawMessages("me@example.com", "INBOX")).find((m) => m.raw.includes("Subject: Secret bcc"));
    check("bcc not visible to recipient", bccDelivered && !/^bcc:/im.test(bccDelivered.raw), bccDelivered?.raw.slice(0, 400));
    check("bcc recipient received it", Boolean(bccInbox), undefined);
    check("Sent copy keeps Bcc + \\Seen", bccSent && /^bcc: me@example\.com/im.test(bccSent.raw) && bccSent.flags.includes("\\Seen"), bccSent?.raw.slice(0, 400));

    // Allowlist
    const blocked = await call("email_send", { to: ["evil@attacker.io"], subject: "x", body: "x" });
    check("SEND_ALLOWLIST blocks outsiders", typeof blocked.__error === "string" && blocked.__error.includes("evil@attacker.io"), blocked);

    // Draft (threaded)
    const draft = await call("email_draft", { email_id: planId, body: "Draft reply for review" });
    const drafts = await rawMessages("me@example.com", "Drafts");
    check(
      "draft saved to Drafts with \\Draft + threading",
      draft.folder === "Drafts" && drafts.length === 1 && drafts[0].flags.includes("\\Draft") && drafts[0].raw.includes(`In-Reply-To: ${plan.messageId}`),
      { draft, n: drafts.length },
    );

    // Organize: mark read + move to trash alias
    const lunch = first.emails[0].id;
    const mod = await call("emails_modify", { email_ids: [lunch], mark_read: true, flag: true, move_to_folder: "trash" });
    const trash = await call("emails_find", { folder: "Trash" });
    check("move to trash alias", mod.moved_to === "Trash" && trash.total === 1 && trash.emails[0].isFlagged && !trash.emails[0].isUnread, { mod, trash: trash.emails[0] });

    // Events: stateless watermark
    const seed = await call("emails_events", {});
    check("events: first call seeds", seed.seeded === true && seed.count === 0 && seed.next_after_uid > 0, seed);
    await call("email_send", { account_name: "alice", to: ["me@example.com"], subject: "Fresh one", body: "new" });
    await sleep(300);
    const ev = await call("emails_events", { after_uid: seed.next_after_uid });
    check("events: after_uid returns only new mail", ev.count >= 1 && ev.messages.some((m) => m.subject === "Fresh one") && ev.next_after_uid > seed.next_after_uid, ev);
    const evNone = await call("emails_events", { after_uid: ev.next_after_uid });
    check("events: nothing past the watermark", evNone.count === 0 && evNone.next_after_uid === ev.next_after_uid, evNone);
    const evCursor = await call("emails_events", {});
    check("events: server cursor advances", evCursor.seeded === false && evCursor.messages.some((m) => m.subject === "Fresh one"), evCursor);

    await client.close();
  } finally {
    server?.kill();
  }

  console.log(failures === 0 ? "\nE2E OK" : `\nE2E FAILED: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[2] === "--print-env") {
  for (const [k, v] of Object.entries({ ...accountsEnv(), MCP_BEARER_TOKEN: TOKEN })) console.log(`${k}=${v}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
