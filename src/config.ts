import { resolve } from 'node:path';

export interface Config {
  ghostUrl: string;
  staffToken: string;
  dataDir: string;
  transport: 'ghst' | 'direct';
  shim: {
    host: string;
    port: number;
    publicUrl: string;
    password: string;
  };
}

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigError(`${key} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/**
 * A staff access token is "<24 hex id>:<64 hex secret>". Checking the shape here
 * turns a confusing 401 from Ghost into a clear message at startup.
 */
export function parseStaffToken(token: string): { id: string; secret: string } {
  const parts = token.split(':');
  if (parts.length !== 2) {
    throw new ConfigError('Staff access token must look like "<id>:<secret>".');
  }
  const [id, secret] = parts as [string, string];
  if (!/^[0-9a-f]+$/i.test(id) || !/^[0-9a-f]+$/i.test(secret)) {
    throw new ConfigError('Staff access token id and secret must both be hex.');
  }
  return { id, secret };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ghostUrl = required(env, 'GHOST_URL').replace(/\/+$/, '');
  const staffToken = required(env, 'GHOST_STAFF_ACCESS_TOKEN');
  parseStaffToken(staffToken);

  const transport = (env.DESK_TRANSPORT ?? 'ghst').trim();
  if (transport !== 'ghst' && transport !== 'direct') {
    throw new ConfigError('DESK_TRANSPORT must be "ghst" or "direct".');
  }

  const port = Number(env.SHIM_PORT ?? 4040);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('SHIM_PORT must be a port number.');
  }

  return {
    ghostUrl,
    staffToken,
    dataDir: resolve(env.DESK_DATA_DIR ?? './data'),
    transport,
    shim: {
      host: env.SHIM_HOST ?? '127.0.0.1',
      port,
      publicUrl: (env.SHIM_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
      password: env.SHIM_PASSWORD ?? '',
    },
  };
}

/**
 * Minimal .env reader. Real environment variables always win, so a shell export
 * can override the file without editing it.
 */
export async function loadDotEnv(path = '.env', env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}
