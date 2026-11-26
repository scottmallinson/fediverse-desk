import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export interface ServeOptions {
  host: string;
  port: number;
  handle: (request: Request) => Promise<Response>;
  onListening?: (address: { host: string; port: number }) => void;
  /** One line per request. Defaults to stderr, so `desk shim` logs without setup. */
  log?: (line: string) => void;
}

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_ERROR_CHARS = 300;

export interface RequestLine {
  at: Date;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  error?: string;
}

/**
 * One line per request: when it started, the method, the path, the status, how
 * long it took, and the error it ended with, if any. The query string is left
 * out because it can carry OAuth state, and headers and bodies are never read
 * here, because they carry tokens and passwords.
 */
export function formatRequestLine(line: RequestLine): string {
  const parts = [
    line.at.toISOString(),
    line.method,
    line.path,
    String(line.status),
    `${line.durationMs}ms`,
  ];
  if (line.error) {
    parts.push(`error=${JSON.stringify(line.error.slice(0, MAX_ERROR_CHARS))}`);
  }
  return parts.join(" ");
}

/**
 * Adapts node:http onto the WHATWG Request/Response pair the app is written
 * against, which keeps the app testable without ever opening a socket.
 */
export function serve(options: ServeOptions): Server {
  const log = options.log ?? defaultLog;
  const server = createServer((incoming, outgoing) => {
    void handleRequest(incoming, outgoing, options.handle, log);
  });

  server.listen(options.port, options.host, () => {
    options.onListening?.({ host: options.host, port: options.port });
  });

  return server;
}

function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handle: (request: Request) => Promise<Response>,
  log: (line: string) => void,
): Promise<void> {
  const started = new Date();
  const method = incoming.method ?? "GET";
  const path = (incoming.url ?? "/").split("?")[0] || "/";
  const record = (status: number, error?: string): void => {
    log(
      formatRequestLine({
        at: started,
        method,
        path,
        status,
        durationMs: Date.now() - started.getTime(),
        ...(error ? { error } : {}),
      }),
    );
  };

  try {
    const request = await toRequest(incoming);
    const response = await handle(request);

    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => {
      outgoing.setHeader(key, value);
    });

    const body = response.body
      ? Buffer.from(await response.arrayBuffer())
      : null;
    outgoing.end(body ?? undefined);
    record(response.status);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    const status = message === "Request body too large" ? 413 : 500;
    outgoing.statusCode = status;
    outgoing.setHeader("Content-Type", "application/json; charset=utf-8");
    outgoing.end(JSON.stringify({ error: message }));
    record(status, message);
  }
}

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const host = incoming.headers.host ?? "localhost";
  const url = new URL(incoming.url ?? "/", `http://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }

  const method = incoming.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  return new Request(url, { method, headers, body: await readBody(incoming) });
}

function readBody(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => resolve(Buffer.concat(chunks)));
    incoming.on("error", reject);
  });
}
