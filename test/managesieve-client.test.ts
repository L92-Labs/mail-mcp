import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManageSieveClient } from "../apps/node/src/managesieve-client.js";

/** Minimal in-process ManageSieve server (RFC 5804 subset) for protocol
 *  tests. Handles commands with non-synchronised literal bodies ({N+} →
 *  N raw bytes follow the command line). Records every exchange. */
class FakeManageSieveServer {
  private server: net.Server;
  private buffer = "";
  readonly received: string[] = [];
  /** Fail the current PUTSCRIPT/CHECKSCRIPT when the literal body contains
   *  this marker (simulates a server-side compile error for CHECKSCRIPT). */
  invalidMarker = "";
  /** LISTSCRIPTS replies with a synchronised-literal script name. */
  literalListName = false;
  /** PUTSCRIPT replies with a WARNINGS response code. */
  warningsOnPut = false;

  constructor() {
    this.server = net.createServer((socket) => {
      socket.write(
        '"IMPLEMENTATION" "Test Server"\r\n"SIEVE" "FILEINTO" "VACATION"\r\n"VERSION" "1.0"\r\nOK "ready"\r\n',
      );
      socket.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        this.processBuffer(socket);
      });
      socket.on("error", () => {});
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
      this.respond(socket, line);
    }
  }

  private respond(socket: net.Socket, line: string): void {
    if (line.startsWith("CAPABILITY")) {
      socket.write('"IMPLEMENTATION" "Test Server"\r\n"SIEVE" "FILEINTO" "VACATION"\r\n"VERSION" "1.0"\r\nOK\r\n');
      return;
    }
    if (line.startsWith("AUTHENTICATE")) {
      socket.write('OK "authenticated"\r\n');
      return;
    }
    if (line.startsWith("LISTSCRIPTS")) {
      if (this.literalListName) {
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
      // Server→client literals are synchronised: {N} CRLF content CRLF.
      const content = 'require ["fileinto"]; keep;\n# demo';
      socket.write(`{${Buffer.byteLength(content)}}\r\n${content}\r\nOK\r\n`);
      return;
    }
    if (line.startsWith("PUTSCRIPT") || line.startsWith("CHECKSCRIPT")) {
      const last = this.received[this.received.length - 1] ?? "";
      if (this.invalidMarker !== "" && last.includes(this.invalidMarker)) {
        socket.write('NO (line: 1:1) "unknown command BOGUS"\r\n');
        return;
      }
      socket.write(
        this.warningsOnPut ? 'OK (WARNINGS "tag kept") "stored"\r\n' : 'OK "stored"\r\n',
      );
      return;
    }
    if (line.startsWith("SETACTIVE")) {
      socket.write('OK "activated"\r\n');
      return;
    }
    if (line.startsWith("DELETESCRIPT")) {
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
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        resolve((this.server.address() as net.AddressInfo).port);
      });
    });
  }

  close(): void {
    this.server.close();
  }
}

describe("ManageSieveClient (fake server)", { timeout: 15_000 }, () => {
  let port = 0;
  const server = new FakeManageSieveServer();
  let client: ManageSieveClient;

  beforeAll(async () => {
    port = await server.listen();
    expect(port).toBeGreaterThan(0);
    client = await ManageSieveClient.connect(
      { host: "127.0.0.1", port, secure: "plain" },
      { imap: { user: "me@loiu92.com", password: "pw" } } as never,
    );
    // RFC 5804 §1.7: greeting/capability lines are bare quoted-token lists
    // with NO "CAPABILITY" substring — a substring-gated parser would see
    // nothing at all (real Dovecot behaves exactly like this).
    expect(client.capabilities).toEqual(
      expect.arrayContaining([
        "IMPLEMENTATION",
        "Test Server",
        "SIEVE",
        "FILEINTO",
        "VACATION",
        "VERSION",
        "1.0",
      ]),
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

  it("PUTSCRIPT surfaces the server's WARNINGS response code", async () => {
    server.warningsOnPut = true;
    const warnings = await client.putScript("active", "keep;");
    server.warningsOnPut = false;
    expect(warnings).toBe("tag kept");
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
