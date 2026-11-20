import type { Readable, Writable } from 'node:stream';

/**
 * Just enough of the Model Context Protocol to serve tools over stdio: JSON-RPC
 * 2.0, one message per line, with initialize, ping, tools/list and tools/call.
 * Written by hand rather than pulled in from the SDK, so the app keeps its
 * promise of no runtime dependencies.
 */

/** Newest first. A client asking for one of these gets it echoed back. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Thrown by a tool for a problem the model can fix by calling it differently.
 * It becomes a tool result with isError set, which the model sees, rather than a
 * protocol error, which it may not.
 */
export class ToolError extends Error {}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | {
      jsonrpc: '2.0';
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export class McpServer {
  private readonly tools = new Map<string, Tool>();

  constructor(
    private readonly options: {
      name: string;
      version: string;
      instructions?: string;
      tools: Tool[];
    },
  ) {
    for (const tool of options.tools) this.tools.set(tool.name, tool);
  }

  /** Answers one parsed message. Notifications get no answer, so return null. */
  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isRequest(message)) {
      return failure(null, INVALID_REQUEST, 'Expected a single JSON-RPC 2.0 request.');
    }

    const isNotification = message.id === undefined;
    if (isNotification) return null;
    const id = message.id ?? null;

    try {
      switch (message.method) {
        case 'initialize':
          return success(id, this.initialize(message.params ?? {}));
        case 'ping':
          return success(id, {});
        case 'tools/list':
          return success(id, { tools: [...this.tools.values()].map(describe) });
        case 'tools/call':
          return await this.call(id, message.params ?? {});
        default:
          return failure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
      }
    } catch (thrown) {
      return failure(id, -32603, thrown instanceof Error ? thrown.message : String(thrown));
    }
  }

  private initialize(params: Record<string, unknown>): Record<string, unknown> {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const result: Record<string, unknown> = {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.options.name, version: this.options.version },
    };
    if (this.options.instructions) result.instructions = this.options.instructions;
    return result;
  }

  private async call(
    id: string | number | null,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = this.tools.get(name);
    if (!tool) return failure(id, INVALID_PARAMS, `Unknown tool: ${name || '(none)'}`);

    const args =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};

    try {
      const value = await tool.handler(args);
      return success(id, {
        content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
        isError: false,
      });
    } catch (thrown) {
      // Upstream failures are reported to the model too: "Ghost said 429" is
      // something it can act on, and a protocol error is not.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      return success(id, { content: [{ type: 'text', text: message }], isError: true });
    }
  }
}

/**
 * Reads newline-delimited JSON-RPC from input and writes answers to output.
 * Resolves when input ends. Nothing but protocol may go to output: a stray log
 * line on stdout corrupts the stream for the client.
 */
export function serveStdio(
  server: McpServer,
  input: Readable,
  output: Writable,
): Promise<void> {
  let buffer = '';
  const pending = new Set<Promise<void>>();

  const write = (response: JsonRpcResponse | null) => {
    if (response) output.write(`${JSON.stringify(response)}\n`);
  };

  const dispatch = (line: string) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(failure(null, PARSE_ERROR, 'Parse error'));
      return;
    }
    const task = server.handle(message).then(write);
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  return new Promise((resolve, reject) => {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        dispatch(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });
    input.on('end', () => {
      dispatch(buffer);
      buffer = '';
      void Promise.allSettled([...pending]).then(() => resolve());
    });
    input.on('error', reject);
  });
}

function describe(tool: Tool): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
  if (tool.annotations) {
    entry.annotations = tool.annotations;
    if (tool.annotations.title) entry.title = tool.annotations.title;
  }
  return entry;
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string';
}

function success(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
