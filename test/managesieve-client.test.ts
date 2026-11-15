import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManageSieveClient } from "../apps/node/src/managesieve-client.js";

const TLS_KEY = fs.readFileSync(new URL("./fixtures/managesieve-tls.key", import.meta.url), "utf8");
const TLS_CERT = fs.readFileSync(new URL("./fixtures/managesieve-tls.crt", import.meta.url), "utf8");
const SECURE_CONTEXT = tls.createSecureContext({ key: TLS_KEY, cert: TLS_CERT });
const TEST_ACCOUNT = { imap: { user: "me@loiu92.com", password: "pw" } } as never;

/** Minimal in-process ManageSieve server (RFC 5804 subset) for protocol
 *  tests. Modes: plain, implicit-tls, starttls. Handles commands with
 *  non-synchronised literal bodies ({N+} → N raw bytes follow the command
 *  line). Records every exchange. */
class FakeManageSieveServer {
  private server?: net.Server | tls.Server;
  private buffer = "";
  readonly received: string[] = [];
  /** True once a STARTTLS upgrade completed on the current connection. */
  upgraded = false;
  /** Override for the LISTSCRIPTS response (raw wire text). */
  listScriptsResponse: string | null = null;
  /** Fail the current PUTSCRIPT/CHECKSCRIPT when the literal body contains
   *  this marker (simulates a server-side compile error for CHECKSCRIPT). */
  invalidMarker = "";
  /** LISTSCRIPTS replies with a synchronised-literal script name. */
  literalListName = false;
  /** Override for the raw LISTSCRIPTS wire response. */
  listScriptsResponse: string | null = null;
  /** Override for the raw GETSCRIPT wire response. */
  getScriptResponse: string | null = null;
  /** PUTSCRIPT replies with a WARNINGS response code. */
  warningsOnPut = false;
  /** DELETESCRIPT replies NO with a trailing-literal message (§2.8). */
  nonexistentDelete = false;
  /** CHECKSCRIPT replies NO with a multiline literal error (§2.12). */
  multilineCheckError = false;
  /** CHECKSCRIPT replies NO whose literal message ends in "{N}". */
  messageEndsWithBrace = false;

  constructor(private readonly mode: "plain" | "implicit-tls" | "starttls" = "plain") {}

  /** RFC 5804 §1.7 greeting; after a STARTTLS upgrade the fresh list drops
   *  STARTTLS (§2.2) — mirrored from real Dovecot behaviour. */
  private greeting(): string {
    const lines = [
      '"IMPLEMENTATION" "Test Server"',
      ...(this.mode === "starttls" && !this.upgraded ? ['"STARTTLS"'] : []),
      '"SIEVE" "FILEINTO"',
      '"VERSION" "1.0"',
    ];
    return lines.join("\r\n") + '\r\nOK "ready"\r\n';
  }

  private attach(socket: net.Socket): void {
    socket.write(this.greeting());
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      this.processBuffer(socket);
    });
  }

  private processBuffer(socket: net.Socket): void {
    for (;;) {
      const lineEnd = this.buffer.indexOf("\r\n");
      if (lineEnd < 0) break;
      const line = this.buffer.slice(0, lineEnd).toString("utf8");
      const literalMatch = /\{(\d+)\+\}$/.exec(line.trimEnd());
      if (literalMatch) {
        const size = Number(literalMatch[1]);
        const bodyStart = lineEnd + 2;
        if (this.buffer.length < bodyStart + size) return; // wait for body
        const body = this.buffer.slice(bodyStart, bodyStart + size).toString("utf8");
        this.buffer = this.buffer.slice(bodyStart + size);
        this.received.push(`${line.trimEnd()}\r\n${body}`);
        this.respond(socket, line.trimEnd());
        continue;
      }
      this.buffer = this.buffer.slice(lineEnd + 2);
      this.received.push(line);
      if (line === "STARTTLS" && this.mode === "starttls" && !this.upgraded) {
        // RFC 5804 §2.2: OK, then the handshake begins; afterwards the
        // server re-issues its capability greeting.
        socket.write('OK "Begin TLS negotiation now."\r\n');
        socket.removeAllListeners("data");
        this.buffer = "";
        const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: SECURE_CONTEXT });
        this.upgraded = true;
        this.attach(secure);
        return;
      }
      this.respond(socket, line);
    }
  }

  private respond(socket: net.Socket, line: string): void {
    if (line.startsWith("CAPABILITY")) {
      socket.write(this.greeting());
      return;
    }
    if (line.startsWith("AUTHENTICATE")) {
      socket.write('OK "authenticated"\r\n');
      return;
    }
    if (line.startsWith("LISTSCRIPTS")) {
      if (this.listScriptsResponse !== null) {
        socket.write(this.listScriptsResponse);
      } else if (this.literalListName) {
        // RFC 5804 §2.7: names with special chars arrive as synchronised
        // literals — {N} CRLF name-bytes continue the same line.
        const name = 'cle"ver';
        socket.write(`{${Buffer.byteLength(name)}}\r\n${name} ACTIVE\r\n"vacation"\r\nOK\r\n`);
      } else {
        socket.write('"active" ACTIVE\r\n"vacation"\r\nOK\r\n');
      }
      return;
    }
    if (line.startsWith("GETSCRIPT")) {
      if (this.getScriptResponse !== null) {
        socket.write(this.getScriptResponse);
        return;
      }
      // Server→client literals are synchronised: {N} CRLF content CRLF.
      const content = 'require ["fileinto"]; keep;\n# demo';
      socket.write(`{${Buffer.byteLength(content)}}\r\n${content}\r\nOK\r\n`);
      return;
    }
    if (line.startsWith("PUTSCRIPT") || line.startsWith("CHECKSCRIPT")) {
      const last = this.received[this.received.length - 1] ?? "";
      if (this.messageEndsWithBrace) {
        // The decoded message itself ends in "{1}" — data, not framing.
        const msg = "syntax error {1}";
        socket.write(`NO {${Buffer.byteLength(msg)}}\r\n${msg}\r\n`);
        return;
      }
      if (this.multilineCheckError) {
        // RFC 5804 §2.12: multi-error reports travel as a multiline literal.
        const errText = "line 1: syntax error\nline 2: unknown command";
        socket.write(`NO {${Buffer.byteLength(errText)}}\r\n${errText}\r\n`);
        return;
      }
      if (this.invalidMarker !== "" && last.includes(this.invalidMarker)) {
        socket.write('NO (line: 1:1) "unknown command BOGUS"\r\n');
        return;
      }
      if (this.warningsOnPut) {
        // RFC 5804 §2.6/§4: the ABNF form carries NO argument; the text is
        // the tagged message itself.
        socket.write('OK (WARNINGS) "line 8: server redirect action limit is 2"\r\n');
        return;
      }
      socket.write('OK "stored"\r\n');
      return;
    }
    if (line.startsWith("SETACTIVE")) {
      socket.write('OK "activated"\r\n');
      return;
    }
    if (line.startsWith("DELETESCRIPT")) {
      if (this.nonexistentDelete) {
        // RFC 5804 §2.8 example: message travels as a trailing literal.
        const msg = "There is no script by that name";
        socket.write(`NO (NONEXISTENT) {${Buffer.byteLength(msg)}}\r\n${msg}\r\n`);
        return;
      }
      socket.write('OK "deleted"\r\n');
      return;
    }
    if (line.startsWith("LOGOUT")) {
      socket.write('OK "bye"\r\n');
      return;
    }
    socket.write('NO "unknown command"\r\n');
  }

  private get lastRaw(): string {
    return this.received.join("\r\n");
  }

  listen(): Promise<number> {
    if (this.mode === "implicit-tls") {
      this.server = tls.createServer({ key: TLS_KEY, cert: TLS_CERT }, (s) => this.attach(s));
    } else {
      this.server = net.createServer((s) => this.attach(s));
    }
    return new Promise((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        resolve((this.server!.address() as net.AddressInfo).port);
      });
    });
  }

  close(): void {
    this.server?.close();
  }
}

describe("ManageSieveClient (fake server, plain)", { timeout: 15_000 }, () => {
  const server = new FakeManageSieveServer("plain");
  let port = 0;
  let client: ManageSieveClient;

  beforeAll(async () => {
    port = await server.listen();
    expect(port).toBeGreaterThan(0);
    client = await ManageSieveClient.connect(
      { host: "127.0.0.1", port, secure: "plain" },
      TEST_ACCOUNT,
    );
    // RFC 5804 §1.7: greeting/capability lines are bare quoted-token lists
    // with NO "CAPABILITY" substring — a substring-gated parser would see
    // nothing at all (real Dovecot behaves exactly like this).
    expect(client.capabilities).toEqual(
      expect.arrayContaining(["IMPLEMENTATION", "Test Server", "SIEVE", "FILEINTO", "VERSION", "1.0"]),
    );
  });

  afterAll(async () => {
    await client.close().catch(() => client.destroy());
    server.close();
  });

  it("AUTHENTICATE PLAIN is sent after connect", () => {
    expect(server.received.some((l) => l.startsWith("AUTHENTICATE"))).toBe(true);
  });

  it("LISTSCRIPTS parses quoted names + ACTIVE flag", async () => {
    const scripts = await client.listScripts();
    expect(scripts).toEqual([
      { name: "active", active: true },
      { name: "vacation", active: false },
    ]);
  });

  it("GETSCRIPT returns the literal-decoded script content", async () => {
    const script = await client.getScript("active");
    expect(script).toBe('require ["fileinto"]; keep;\n# demo');
  });

  it("PUTSCRIPT sends the content as a non-synchronised literal", async () => {
    const content = 'require ["vacation"]; keep;\nfileinto :create "INBOX/test";';
    await client.putScript("active", content);
    const size = Buffer.byteLength(content);
    expect(server.received).toContain(`PUTSCRIPT "active" {${size}+}\r\n${content}`);
  });

  it("CHECKSCRIPT invalid content returns valid: false with the server error", async () => {
    server.invalidMarker = "BOGUS";
    const r = await client.checkScript("BOGUS script");
    server.invalidMarker = "";
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("unknown command BOGUS");
  });

  it("CHECKSCRIPT valid content returns valid: true", async () => {
    const r = await client.checkScript("keep;");
    expect(r.valid).toBe(true);
  });

  it("LISTSCRIPTS decodes synchronised-literal names (RFC 5804 §2.7)", async () => {
    server.literalListName = true;
    const scripts = await client.listScripts();
    server.literalListName = false;
    expect(scripts).toEqual([
      { name: 'cle"ver', active: true },
      { name: "vacation", active: false },
    ]);
  });

  it("literal-name bytes are never confused with the ACTIVE marker", async () => {
    // {10} announces 10 bytes: the NAME is "foo ACTIVE" — the marker is
    // absent, so the script is inactive and the name keeps its spaces.
    server.listScriptsResponse = '{10}\r\nfoo ACTIVE\r\nOK\r\n';
    const scripts = await client.listScripts();
    server.listScriptsResponse = null;
    expect(scripts).toEqual([{ name: "foo ACTIVE", active: false }]);
  });

  it("GETSCRIPT decodes a quoted-script response (RFC 5804 §4 string form)", async () => {
    server.getScriptResponse = '"keep;"\r\nOK\r\n';
    const script = await client.getScript("active");
    server.getScriptResponse = null;
    expect(script).toBe("keep;");
  });

  it("PUTSCRIPT surfaces the bare (WARNINGS) form per RFC 5804 §2.6", async () => {
    server.warningsOnPut = true;
    const warnings = await client.putScript("active", "keep;");
    server.warningsOnPut = false;
    expect(warnings).toBe("line 8: server redirect action limit is 2");
  });

  it("DELETESCRIPT error with trailing-literal message surfaces the text (RFC 5804 §2.8)", async () => {
    server.nonexistentDelete = true;
    await expect(client.deleteScript("baz")).rejects.toThrow(/There is no script by that name/);
    server.nonexistentDelete = false;
    // The literal bytes did not linger in the buffer: the dialogue is intact.
    await client.deleteScript("vacation");
    expect(server.received[server.received.length - 1]).toBe('DELETESCRIPT "vacation"');
  });

  it("CHECKSCRIPT multiline literal errors are surfaced (RFC 5804 §2.12)", async () => {
    server.multilineCheckError = true;
    const r = await client.checkScript("bad;");
    server.multilineCheckError = false;
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("line 1: syntax error");
    expect(r.errors).toContain("line 2: unknown command");
  });

  it("decoded literal messages ending in {N} are data, not framing", async () => {
    server.messageEndsWithBrace = true;
    const r = await client.checkScript("bad;");
    server.messageEndsWithBrace = false;
    // The decoded "{1}" did not hijack framing detection: the error came
    // back promptly instead of hanging on a phantom 1-byte literal.
    expect(r.valid).toBe(false);
    expect(r.errors).toBe("syntax error {1}");
  });

  it("SETACTIVE and DELETESCRIPT send quoted names", async () => {
    await client.setActive("vacation");
    expect(server.received).toContain('SETACTIVE "vacation"');
    await client.deleteScript("vacation");
    expect(server.received).toContain('DELETESCRIPT "vacation"');
  });

  it("names with CRLF are sent as literals (injection-safe)", async () => {
    const evil = 'evil\r\nDELETESCRIPT "everything"';
    await client.setActive(evil);
    const last = server.received[server.received.length - 1];
    // The name went out as ONE non-synchronised literal datum: the CRLF
    // inside it did NOT split the dialogue into a second command line.
    expect(last).toBe(`SETACTIVE {${Buffer.byteLength(evil)}+}\r\n${evil}`);
    await client.deleteScript(evil);
  });

  it("LOGOUT closes the connection", async () => {
    await client.close();
  });
});

describe("ManageSieveClient STARTTLS upgrade (RFC 5804 §2.2)", { timeout: 15_000 }, () => {
  const server = new FakeManageSieveServer("starttls");

  it("sends STARTTLS first, consumes the re-issued greeting, then works", async () => {
    const port = await server.listen();
    const client = await ManageSieveClient.connect(
      { host: "127.0.0.1", port, secure: "starttls" },
      TEST_ACCOUNT,
      false, // self-signed test fixture
    );
    // The command went out in plaintext BEFORE the TLS handshake started.
    expect(server.received).toContain("STARTTLS");
    expect(server.upgraded).toBe(true);
    // §2.2: cached capabilities are REPLACED by the post-handshake greeting,
    // which must NOT advertise STARTTLS any more.
    expect(client.capabilities).not.toContain("STARTTLS");
    expect(client.capabilities).toEqual(
      expect.arrayContaining(["IMPLEMENTATION", "Test Server", "SIEVE", "VERSION", "1.0"]),
    );
    // Command/response alignment after the upgrade.
    const scripts = await client.listScripts();
    expect(scripts).toEqual([
      { name: "active", active: true },
      { name: "vacation", active: false },
    ]);
    await client.close();
    server.close();
  });
});

describe("ManageSieveClient implicit TLS (RFC 5804 §1.8)", { timeout: 15_000 }, () => {
  const server = new FakeManageSieveServer("implicit-tls");

  it("consumes the TLS greeting before sending commands", async () => {
    const port = await server.listen();
    const client = await ManageSieveClient.connect(
      { host: "127.0.0.1", port, secure: "tls" },
      TEST_ACCOUNT,
      false, // self-signed test fixture
    );
    // If the greeting had not been consumed, AUTHENTICATE's response would
    // be read by LISTSCRIPTS and the list would come back empty.
    expect(server.received.some((l) => l.startsWith("AUTHENTICATE"))).toBe(true);
    const scripts = await client.listScripts();
    expect(scripts).toEqual([
      { name: "active", active: true },
      { name: "vacation", active: false },
    ]);
    await client.close();
    server.close();
  });
});

describe("ManageSieveClient SNI (implicit TLS)", { timeout: 15_000 }, () => {
  it("sends the configured hostname in the ClientHello SNI extension", async () => {
    // RFC 6066: SNI carries DNS hostnames only (never IP literals), so a
    // hostname host is required to exercise the extension. A raw TCP probe
    // inspects the plaintext ClientHello — Node v24 ignores server-side
    // sniCallback when a default key/cert context exists.
    let hello = "";
    const srv = net.createServer((s) => {
      s.once("data", (chunk: Buffer) => {
        hello = chunk.toString("latin1");
        s.destroy();
      });
    });
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port));
    });
    await ManageSieveClient.connect(
      { host: "localhost", port, secure: "tls" },
      TEST_ACCOUNT,
      false,
    ).then(
      () => {
        throw new Error("TLS handshake should not succeed against a raw probe");
      },
      () => {}, // handshake failure is expected; the probe already has the bytes
    );
    srv.close();
    expect(hello).toContain("localhost");
  });

  it("does not send SNI for IP-literal hosts (RFC 6066)", async () => {
    let hello = "";
    const srv = net.createServer((s) => {
      s.once("data", (chunk: Buffer) => {
        hello = chunk.toString("latin1");
        s.destroy();
      });
    });
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port));
    });
    await ManageSieveClient.connect(
      { host: "127.0.0.1", port, secure: "tls" },
      TEST_ACCOUNT,
      false,
    ).then(
      () => {
        throw new Error("TLS handshake should not succeed against a raw probe");
      },
      () => {},
    );
    srv.close();
    // RFC 6066: SNI carries DNS hostnames only — an IP-literal host must
    // not appear in the ServerNameList.
    expect(hello).not.toContain("127.0.0.1");
  });
});

describe("ManageSieveClient literal-name safety", { timeout: 15_000 }, () => {
  it("a script named NO arrives as data, not as a refusal", async () => {
    const server = new FakeManageSieveServer("plain");
    const port = await server.listen();
    const client = await ManageSieveClient.connect(
      { host: "127.0.0.1", port, secure: "plain" },
      TEST_ACCOUNT,
    );
    server.listScriptsResponse = '{2}\r\nNO\r\nOK "listed"\r\n';
    const scripts = await client.listScripts();
    expect(scripts).toEqual([{ name: "NO", active: false }]);
    await client.close();
    // The dialogue stayed aligned end-to-end: LOGOUT's OK was the final
    // exchange, with no stale response left pending in the buffer.
    expect(server.received[server.received.length - 1]).toBe("LOGOUT");
    server.close();
  });

  it("a script named OK arrives as data, not as a completion", async () => {
    const server = new FakeManageSieveServer("plain");
    const port = await server.listen();
    const client = await ManageSieveClient.connect(
      { host: "127.0.0.1", port, secure: "plain" },
      TEST_ACCOUNT,
    );
    server.listScriptsResponse = '{2}\r\nOK\r\nOK\r\n';
    const scripts = await client.listScripts();
    expect(scripts).toEqual([{ name: "OK", active: false }]);
    await client.close();
    server.close();
  });
});
