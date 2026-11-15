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
  isSieveLiteral,
  isSieveNo,
  isSieveOk,
  parseCapabilityLine,
  parseListScriptsEntry,
  quoteSieveString,
  sieveTaggedMessage,
} from "@mail-mcp/core";

const INACTIVITY_TIMEOUT_MS = 20_000;

/** A single ManageSieve command exchange: untagged lines + tagged result. */
interface SieveResult {
  untagged: string[];
  tagged: string;
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
  }

  /** Connect, STARTTLS (if configured and advertised), AUTHENTICATE PLAIN
   *  with the account's IMAP credentials. */
  static async connect(
    config: SieveConfig,
    account: EmailAccount,
    tlsVerify = true,
  ): Promise<ManageSieveClient> {
    const client = new ManageSieveClient(
      net.createConnection({ host: config.host, port: config.port }),
      config.host,
    );
    await client.waitConnected();
    client.attach();
    await client.readGreeting();
    if (config.secure === "tls") {
      await client.upgradeTls(tlsVerify);
    }
    const caps = await client.capability();
    if (config.secure === "starttls") {
      if (!caps.some((c) => c.toUpperCase() === "STARTTLS")) {
        await client.close();
        throw new Error(
          `ManageSieve server ${config.host}:${config.port} does not advertise STARTTLS`,
        );
      }
      await client.command("STARTTLS");
      await client.upgradeTls(tlsVerify);
      await client.capability(); // refresh post-TLS capabilities
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
    await client.command(`AUTHENTICATE "PLAIN" "${plain}"`);
    return client;
  }

  // ---------- SieveBackend-style operations ----------

  async listScripts(): Promise<SieveScriptSummary[]> {
    const res = await this.command("LISTSCRIPTS");
    const out: SieveScriptSummary[] = [];
    for (const line of res.untagged) {
      const entry = parseListScriptsEntry(line);
      if (entry && entry.name !== "@literal:@") out.push(entry);
    }
    return out;
  }

  async getScript(name: string): Promise<string> {
    const res = await this.command(`GETSCRIPT ${quoteSieveString(name)}`);
    const literal = res.untagged.map(isSieveLiteral).find(Boolean);
    if (!literal) throw new Error(`script "${name}" is empty or the server sent no content`);
    return await this.readLiteralRaw(literal.size);
  }

  async putScript(name: string, content: string): Promise<void> {
    const bytes = Buffer.from(content, "utf8");
    await this.sendBytes(`PUTSCRIPT ${quoteSieveString(name)} {${bytes.length}+}\r\n`, bytes);
    await this.readTagged();
  }

  async checkScript(content: string): Promise<SieveCheckResult> {
    const bytes = Buffer.from(content, "utf8");
    try {
      await this.sendBytes(`CHECKSCRIPT {${bytes.length}+}\r\n`, bytes);
      await this.readTagged();
      return { valid: true };
    } catch (err) {
      return { valid: false, errors: err instanceof Error ? err.message : String(err) };
    }
  }

  async setActive(name: string): Promise<void> {
    await this.command(`SETACTIVE ${quoteSieveString(name)}`);
  }

  async deleteScript(name: string): Promise<void> {
    await this.command(`DELETESCRIPT ${quoteSieveString(name)}`);
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

  private upgradeTls(rejectUnauthorized: boolean): Promise<void> {
    const host = this.host;
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    plain.setTimeout(0);
    return new Promise((resolve, reject) => {
      const secure = tls.connect(
        { socket: plain, servername: host, rejectUnauthorized },
        () => {
          this.socket = secure;
          this.buffer = Buffer.alloc(0);
          this.attach();
          resolve();
        },
      );
      secure.once("error", (err: Error) => reject(err));
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
            : new Error("connection closed"),
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

  /** Read a full server response: untagged lines (and literals) until a
   *  tagged OK/NO/BYE line. */
  private async readTagged(): Promise<SieveResult> {
    const untagged: string[] = [];
    for (;;) {
      const line = await this.readLine();
      const literal = isSieveLiteral(line);
      if (literal) {
        // Server literal: N bytes followed by CRLF (part of the next line).
        const content = await this.readLiteralRaw(literal.size);
        untagged.push(content);
        continue;
      }
      if (isSieveBye(line)) {
        this.destroy();
        throw new Error(`ManageSieve server sent BYE: ${sieveTaggedMessage(line.slice(4).trim())}`);
      }
      if (isSieveOk(line) || isSieveNo(line)) {
        const message = line.trim().split(/\s+(.*)$/s)[1] ?? "";
        return { untagged, tagged: sieveTaggedMessage(message) };
      }
      untagged.push(line);
    }
  }

  /** Read exactly n raw bytes then a CRLF (server-to-client literal). */
  private async readLiteralRaw(size: number): Promise<string> {
    for (;;) {
      if (this.buffer.length >= size) {
        const content = this.buffer.subarray(0, size).toString("utf8");
        this.buffer = this.buffer.subarray(size);
        // swallow trailing CRLF
        if (this.buffer.subarray(0, 2).toString() === "\r\n") this.buffer = this.buffer.subarray(2);
        return content;
      }
      if (this.closed) throw new Error("connection closed while reading literal");
      await this.feedAndWait();
    }
  }

  /** Send a command line and return the tagged result. Throws on NO/BYE. */
  private async command(line: string): Promise<SieveResult> {
    const res = await this.sendLineGetResult(line);
    if (isSieveNo(res.tagged)) {
      throw new Error(`ManageSieve server refused: ${res.tagged}`);
    }
    return res;
  }

  private async sendLineGetResult(line: string): Promise<SieveResult> {
    this.write(`${line}\r\n`);
    return this.readTagged();
  }

  /** Send a command prefix + a non-synchronised literal body. */
  private async sendBytes(prefix: string, bytes: Buffer): Promise<void> {
    this.write(prefix);
    this.write(bytes);
    await this.readTagged();
  }

  private write(data: string | Buffer): void {
    if (this.closed) throw new Error("connection closed");
    this.socket.write(data);
  }

  /** Read the server greeting (untagged CAPABILITY line + OK). */
  private async readGreeting(): Promise<void> {
    const res = await this.readTagged();
    for (const line of res.untagged) {
      if (line.toUpperCase().includes("CAPABILITY")) {
        this.capabilities = parseCapabilityLine(line);
      }
    }
  }

  /** CAPABILITY command; stores the advertised capabilities. */
  async capability(): Promise<string[]> {
    const res = await this.command("CAPABILITY");
    for (const line of res.untagged) {
      if (line.toUpperCase().includes("CAPABILITY")) {
        this.capabilities = parseCapabilityLine(line);
      }
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

  async putScript(account: EmailAccount, name: string, content: string): Promise<void> {
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
