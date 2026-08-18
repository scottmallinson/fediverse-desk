import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface ServeOptions {
  host: string;
  port: number;
  handle: (request: Request) => Promise<Response>;
  onListening?: (address: { host: string; port: number }) => void;
}

const MAX_BODY_BYTES = 12 * 1024 * 1024;

/**
 * Adapts node:http onto the WHATWG Request/Response pair the app is written
 * against, which keeps the app testable without ever opening a socket.
 */
export function serve(options: ServeOptions): Server {
  const server = createServer((incoming, outgoing) => {
    void handleRequest(incoming, outgoing, options.handle);
  });

  server.listen(options.port, options.host, () => {
    options.onListening?.({ host: options.host, port: options.port });
  });

  return server;
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handle: (request: Request) => Promise<Response>,
): Promise<void> {
  try {
    const request = await toRequest(incoming);
    const response = await handle(request);

    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => {
      outgoing.setHeader(key, value);
    });

    const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
    outgoing.end(body ?? undefined);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    outgoing.statusCode = message === 'Request body too large' ? 413 : 500;
    outgoing.setHeader('Content-Type', 'application/json; charset=utf-8');
    outgoing.end(JSON.stringify({ error: message }));
  }
}

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const host = incoming.headers.host ?? 'localhost';
  const url = new URL(incoming.url ?? '/', `http://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }

  const method = incoming.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }

  return new Request(url, { method, headers, body: await readBody(incoming) });
}

function readBody(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    incoming.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.on('end', () => resolve(Buffer.concat(chunks)));
    incoming.on('error', reject);
  });
}
