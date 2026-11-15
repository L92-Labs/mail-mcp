import net from "node:net";
import tls from "node:tls";
import type {
  EmailAccount,
  SieveBackend,
  SieveCheckResult,
  SieveConfig,
  SieveScriptSummary,
} from "@mail-mcp/core";
import {
  isSieveBye,
  isSieveNo,
  isSieveOk,
  parseCapabilityLine,
  parseListScriptsEntry,
  quoteSieveString,
  sieveTaggedMessage,
  unescapeSieveString,
} from "@mail-mcp/core";

const INACTIVITY_TIMEOUT_MS = 20_000;

/** A single ManageSieve command exchange: untagged lines + tagged result. */
interface SieveResult {
  untagged: string[];
  /** Parallel to untagged: true when the line was assembled from a leading
   *  synchronised literal (RFC 5804 §2.7/§2.9) — the exact literal bytes
   *  are in literalValues[i], the line remainder in untagged[i]. */
  fromLiteral: boolean[];
  /** Exact literal byte content for entries flagged in fromLiteral. */
  literalValues: string[];
  /** The raw tagged line (e.g. `OK "done"`) — apply isSieveOk/isSieveNo. */
  tagged: string;
  /** Human-readable text extracted from the tagged line. */
  message: string;
}

/** Names that need the non-synchronised literal form on the wire: quotes,
 *  backslashes, CR/LF or other control characters would break the quoted
 *  form (CR/LF = line injection). */
function needsLiteralForm(name: string): boolean {
  return /["\\\r\n\x00-\x1f\x7f]/.test(name);
}

/** A command segment: wire text (command word, quoted string) or a Buffer,
 *  which is sent as a non-synchronised literal argument ({N+} CRLF bytes). */
type CmdPart = string | Buffer;

/** Render a script name argument: quoted when safe, literal otherwise. */
function namePart(name: string): CmdPart {
  if (!needsLiteralForm(name)) return quoteSieveString(name);
  return Buffer.from(name, "utf8");
}

/** RFC 5804 ManageSieve client (Node runtime). Plain connect → STARTTLS →
 *  AUTHENTICATE PLAIN (Debian's disable_plaintext_auth rejects auth before
 *  TLS). One connection per tool call; LOGOUT at the end. */
export class ManageSieveClient {
  capabilities: string[] = [];

  private socket: net.Socket | tls.TLSSocket;
  private buffer = Buffer.alloc(0);
  private host: string;
  private closed = false;
  private readResolver: (() => void) | null = null;
  private lastError: Error | null = null;

  private constructor(socket: net.Socket | tls.TLSSocket, host: string) {
    this.socket = socket;
    this.host = host;
    this.attach();
  }

  /** Connect, STARTTLS (if configured and advertised), AUTHENTICATE PLAIN
   *  with the account's IMAP credentials. */
  static async connect(
    config: SieveConfig,
    account: EmailAccount,
    tlsVerify = true,
    ca?: string,
  ): Promise<ManageSieveClient> {
    let client: ManageSieveClient;
    if (config.secure === "tls") {
      // Implicit TLS: encrypt BEFORE reading the greeting (a plaintext
      // connect would deadlock — the server waits for a ClientHello).
      const secure = tls.connect({
        host: config.host,
        port: config.port,
        // SNI — tls.connect does not derive servername from host at all
        // (probed on Node v24: no SNI is sent for DNS *or* IP hosts unless
        // servername is set explicitly). Set it for DNS hosts so SNI-routing
        // endpoints select the right certificate. RFC 6066 forbids IP
        // literals in the ServerNameList — the explicit undefined keeps IP
        // hosts SNI-free even on runtimes that would default host→SNI.
        servername: net.isIP(config.host) ? undefined : config.host,
        rejectUnauthorized: tlsVerify,
        ca: ca ? [ca] : undefined,
      });
      client = new ManageSieveClient(secure, config.host);
      await client.waitConnected();
      await client.readGreeting();
    } else {
      client = new ManageSieveClient(
        net.createConnection({ host: config.host, port: config.port }),
        config.host,
      );
      await client.waitConnected();
      await client.readGreeting();
      if (config.secure === "starttls") {
        // RFC 5804 §2.2: send STARTTLS and await its OK; the TLS handshake
        // begins immediately after the CRLF of that OK. TLS bytes must
        // never precede the command.
        if (!client.capabilities.some((c) => c.toUpperCase() === "STARTTLS")) {
          await client.close();
          throw new Error(
            `ManageSieve server ${config.host}:${config.port} does not advertise STARTTLS`,
          );
        }
        try {
          await client.command("STARTTLS");
          await client.startTls(tlsVerify, ca);
          // §2.2: the server re-issues its capability greeting immediately
          // after the handshake (verified against Dovecot Pigeonhole: the
          // fresh list drops STARTTLS and widens SASL).
          await client.readGreeting();
        } catch (err) {
          // A refusal (NO) or handshake failure must not leak the socket.
          client.destroy();
          throw err;
        }
      }
    }
    if (!client.capabilities.some((c) => c.toUpperCase() === "SIEVE")) {
      await client.close();
      throw new Error(
        `ManageSieve server ${config.host}:${config.port} does not advertise SIEVE support`,
      );
    }
    const user = account.imap.user;
    const pass = account.imap.password;
    const authzid = "";
    const plain = Buffer.from(`${authzid}\0${user}\0${pass}`, "utf8").toString("base64");
    try {
      await client.command(`AUTHENTICATE "PLAIN" "${plain}"`);
    } catch (err) {
      // A rejected AUTHENTICATE leaves the connection open server-side —
      // destroy it instead of letting bad-credential retries accumulate
      // sockets until the inactivity timeout.
      client.destroy();
      throw err;
    }
    return client;
  }

  // ---------- SieveBackend-style operations ----------

  async listScripts(): Promise<SieveScriptSummary[]> {
    const res = await this.command("LISTSCRIPTS");
    const out: SieveScriptSummary[] = [];
    res.untagged.forEach((line, i) => {
      if (res.fromLiteral[i]) {
        // Literal-assembled entry: the name is EXACTLY the literal bytes —
        // " ACTIVE" may belong to the name itself, so the active marker is
        // parsed only from the remainder (untagged[i]), never from the
        // concatenated bytes (RFC 5804 §2.7).
        const active = /\s+ACTIVE$/i.exec(res.untagged[i]) !== null;
        out.push({ name: res.literalValues[i], active });
        return;
      }
      const entry = parseListScriptsEntry(line);
      if (entry) out.push(entry);
    });
    return out;
  }

  async getScript(name: string): Promise<string> {
    const res = await this.command("GETSCRIPT ", namePart(name));
    if (res.fromLiteral[0]) return res.literalValues[0];
    // RFC 5804 §4: sieve-script is a string — a server MAY answer short
    // scripts as a quoted string; decode it like any quoted value.
    const line = res.untagged[0] ?? "";
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(line.trim());
    return quoted ? unescapeSieveString(quoted[1]) : line;
  }

  async putScript(name: string, content: string): Promise<string | undefined> {
    // RFC 5804 §2.6: the script content is the final argument, sent as a
    // non-synchronised literal {N+} — multi-line scripts would otherwise
    // inject CRLFs into the command stream.
    const res = await this.command(
      "PUTSCRIPT ",
      namePart(name),
      " ",
      Buffer.from(content, "utf8"),
    );
    if (isSieveNo(res.tagged)) throw new Error(`PUTSCRIPT refused: ${res.message}`);
    // RFC 5804 §2.6 + §4 ABNF: WARNINGS carries no argument — the warning
    // text is the tagged OK message itself. Tolerate a quoted-argument
    // form too (some servers include it).
    const code = /\(WARNINGS\b[^)]*\)/i.exec(res.tagged);
    if (!code) return undefined;
    const quoted = /"((?:[^"\\]|\\.)*)"/.exec(code[0]);
    return quoted ? unescapeSieveString(quoted[1]) : res.message;
  }

  async checkScript(content: string): Promise<SieveCheckResult> {
    // sendParts, not command(): a NO here is the expected "invalid script"
    // outcome, not a transport error to throw.
    const res = await this.sendParts(["CHECKSCRIPT ", Buffer.from(content, "utf8")]);
    if (isSieveNo(res.tagged)) return { valid: false, errors: res.message };
    return { valid: true };
  }

  async setActive(name: string): Promise<void> {
    const res = await this.command("SETACTIVE ", namePart(name));
    if (isSieveNo(res.tagged)) throw new Error(`SETACTIVE refused: ${res.message}`);
  }

  async deleteScript(name: string): Promise<void> {
    const res = await this.command("DELETESCRIPT ", namePart(name));
    if (isSieveNo(res.tagged)) throw new Error(`DELETESCRIPT refused: ${res.message}`);
  }

  /** LOGOUT and close. */
  async close(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      // BYE handling in readTagged already surfaces; ignore here.
    }
    this.destroy();
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }

  // ---------- protocol mechanics ----------

  private attach(): void {
    this.socket.setNoDelay(true);
    this.socket.setTimeout(INACTIVITY_TIMEOUT_MS);
    this.socket.on("timeout", () => {
      this.lastError = new Error(`inactivity timeout after ${INACTIVITY_TIMEOUT_MS}ms`);
      this.destroy();
      this.readResolver?.();
    });
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.readResolver?.();
    });
    this.socket.on("error", (err: Error) => {
      this.lastError = err;
      this.readResolver?.();
    });
    this.socket.on("close", () => {
      this.closed = true;
      this.readResolver?.();
    });
  }

  private waitConnected(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`connect timeout: ${this.host}`)),
        INACTIVITY_TIMEOUT_MS,
      );
      this.socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Upgrade the plain socket to TLS (STARTTLS), re-attaching listeners. */
  private startTls(tlsVerify: boolean, ca?: string): Promise<void> {
    const host = this.host;
    const plain = this.socket;
    plain.setTimeout(0);
    plain.removeAllListeners("timeout");
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    // A TLS ServerHello may already sit in the buffer, coalesced into the
    // same TCP chunk as the STARTTLS OK — re-inject it into the socket
    // instead of discarding, or the handshake stalls waiting for bytes
    // that will never arrive.
    if (this.buffer.length > 0) plain.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
    return new Promise((resolve, reject) => {
      // The handshake has no socket timeout attached (listeners are
      // detached) — bound it explicitly.
      const timer = setTimeout(
        () => reject(new Error(`TLS handshake timeout: ${host}`)),
        INACTIVITY_TIMEOUT_MS,
      );
      const secure = tls.connect(
        {
          socket: plain,
          // Certificate identity: without host, an IP target would be
          // verified against "localhost" and fail; servername stays
          // undefined for IPs (RFC 6066) and SNI is never sent for them.
          host,
          servername: net.isIP(host) ? undefined : host,
          rejectUnauthorized: tlsVerify,
          ca: ca ? [ca] : undefined,
        },
        () => {
          clearTimeout(timer);
          this.socket = secure;
          this.attach();
          resolve();
        },
      );
      secure.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private feedAndWait(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.readResolver = () => {
        this.readResolver = null;
        resolve();
      };
      if (this.closed) {
        reject(
          this.lastError
            ? new Error(`connection closed: ${this.lastError.message}`)
            : new Error("connection closed by server"),
        );
      }
    });
  }

  /** Read one CRLF-terminated line from the buffer. */
  private async readLine(): Promise<string> {
    for (;;) {
      const idx = this.buffer.indexOf("\r\n");
      if (idx >= 0) {
        const line = this.buffer.subarray(0, idx).toString("utf8");
        this.buffer = this.buffer.subarray(idx + 2);
        return line;
      }
      if (this.closed) throw new Error("connection closed by server");
      await this.feedAndWait();
    }
  }

  /** Read a full server response: untagged lines until a tagged OK/NO/BYE
   *  line. A leading synchronised literal ({N}) — LISTSCRIPTS names,
   *  GETSCRIPT content (RFC 5804 §2.7/§2.9) — means the N bytes continue
   *  THIS line as data; they are never classified as a tagged result, so a
   *  script named "OK" or "NO" cannot corrupt the response stream. */
  private async readTagged(): Promise<SieveResult> {
    const untagged: string[] = [];
    const fromLiteral: boolean[] = [];
    const literalValues: string[] = [];
    const push = (line: string, literalValue?: string) => {
      untagged.push(line);
      fromLiteral.push(literalValue !== undefined);
      literalValues.push(literalValue ?? "");
    };
    for (;;) {
      let line = await this.readLine();
      const literal = /^\{(\d+)\}$/.exec(line);
      if (literal) {
        // Leading synchronised literal: pure data (LISTSCRIPTS names,
        // GETSCRIPT content — RFC 5804 §2.7/§2.9). Never classified as a
        // tagged result. untagged[i] holds ONLY the line remainder; the
        // exact byte boundary stays in literalValues[i] so a name like
        // "foo ACTIVE" is never confused with the ACTIVE marker.
        const bytes = await this.readLiteralBytes(Number(literal[1]));
        const rest = await this.readLine();
        push(rest, bytes);
        continue;
      }
      // Trailing literal: a tagged line whose human-readable message travels
      // as a synchronised literal (RFC 5804 §2.8 `No (NONEXISTENT) {31}`,
      // §2.12 multiline compile errors — quoted strings cannot hold raw
      // CRLFs). Resolve the bytes into the line before classifying it, or
      // they would linger in the buffer and corrupt the next exchange.
      // Decoded bytes are DATA, never framing: scanning continues only on
      // fresh wire segments, so a message ending in "{N}" cannot hijack
      // the dialogue (e.g. `NO {16}` + "syntax error {1}").
      let out = "";
      let wire = line;
      for (;;) {
        const t = /\{(\d+)\}$/.exec(wire);
        if (!t) {
          out += wire;
          break;
        }
        out += wire.slice(0, t.index);
        out += await this.readLiteralBytes(Number(t[1]));
        wire = await this.readLine();
      }
      line = out;
      if (isSieveBye(line)) {
        this.destroy();
        throw new Error(`ManageSieve server sent BYE: ${sieveTaggedMessage(line.slice(4).trim())}`);
      }
      if (isSieveOk(line) || isSieveNo(line)) {
        const rest = line.trim().split(/\s+(.*)$/s)[1] ?? "";
        return {
          untagged,
          fromLiteral,
          literalValues,
          tagged: line.trim(),
          message: sieveTaggedMessage(rest),
        };
      }
      push(line);
    }
  }

  /** Read exactly n raw bytes (synchronised literal content). */
  private async readLiteralBytes(size: number): Promise<string> {
    for (;;) {
      if (this.buffer.length >= size) {
        const content = this.buffer.subarray(0, size).toString("utf8");
        this.buffer = this.buffer.subarray(size);
        return content;
      }
      if (this.closed) throw new Error("connection closed while reading literal");
      await this.feedAndWait();
    }
  }

  /** Send a command (wire-text parts + literal-argument Buffers) and return
   *  the tagged result. A trailing CRLF closes the command line unless the
   *  command ENDS with a literal — a literal body is self-terminating
   *  (RFC 5804 §1.6: the {N+} CRLF bytes form is never followed by CRLF). */
  private async sendParts(parts: CmdPart[]): Promise<SieveResult> {
    const last = parts[parts.length - 1];
    for (const part of parts) {
      if (typeof part === "string") {
        this.write(part);
      } else {
        this.write(`{${part.length}+}\r\n`);
        this.write(part);
      }
    }
    if (typeof last === "string") this.write("\r\n");
    return this.readTagged();
  }

  /** Send a command and return the tagged result. Throws on NO. */
  private async command(...parts: CmdPart[]): Promise<SieveResult> {
    const res = await this.sendParts(parts);
    if (isSieveNo(res.tagged)) {
      throw new Error(`ManageSieve server refused: ${res.message || res.tagged}`);
    }
    return res;
  }

  private write(data: string | Buffer): void {
    if (this.closed) throw new Error("connection closed");
    this.socket.write(data);
  }

  /** Read the server greeting: capability lines + OK. RFC 5804 §2.2 — the
   *  greeting REPLACES cached capabilities (fresh list after STARTTLS). */
  private async readGreeting(): Promise<void> {
    const res = await this.readTagged();
    this.capabilities = res.untagged.flatMap((line) => parseCapabilityLine(line));
  }

  /** CAPABILITY command; merges the advertised capabilities. */
  async capability(): Promise<string[]> {
    const res = await this.command("CAPABILITY");
    for (const line of res.untagged) {
      this.capabilities.push(...parseCapabilityLine(line));
    }
    return this.capabilities;
  }
}

/**
 * SieveBackend implementation: opens a fresh ManageSieve connection per
 * operation (mirrors the withImap pattern) using the account's IMAP
 * credentials.
 */
export class ManageSieveBackend implements SieveBackend {
  constructor(
    private readonly config: SieveConfig,
    private readonly credentials: (account: EmailAccount) => { user: string; password: string },
    private readonly tlsVerify = true,
  ) {}

  private async withConnection<T>(
    account: EmailAccount,
    fn: (client: ManageSieveClient) => Promise<T>,
  ): Promise<T> {
    const { user, password } = this.credentials(account);
    const client = await ManageSieveClient.connect(
      this.config,
      { ...account, imap: { ...account.imap, user, password } },
      this.tlsVerify,
    );
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => client.destroy());
    }
  }

  async capabilities(account: EmailAccount): Promise<string[]> {
    return this.withConnection(account, (client) => client.capability());
  }

  async listScripts(account: EmailAccount): Promise<SieveScriptSummary[]> {
    return this.withConnection(account, (client) => client.listScripts());
  }

  async getScript(account: EmailAccount, name: string): Promise<string> {
    return this.withConnection(account, (client) => client.getScript(name));
  }

  async putScript(account: EmailAccount, name: string, content: string): Promise<string | undefined> {
    return this.withConnection(account, (client) => client.putScript(name, content));
  }

  async checkScript(account: EmailAccount, content: string): Promise<SieveCheckResult> {
    return this.withConnection(account, (client) => client.checkScript(content));
  }

  async setActive(account: EmailAccount, name: string): Promise<void> {
    return this.withConnection(account, (client) => client.setActive(name));
  }

  async deleteScript(account: EmailAccount, name: string): Promise<void> {
    return this.withConnection(account, (client) => client.deleteScript(name));
  }
}
