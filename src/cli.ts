#!/usr/bin/env node
import { loadConfig, loadDotEnv, type Config } from './config.js';
import { DirectSocialWeb } from './ghost/direct.js';
import { GhstSocialWeb } from './ghost/ghst.js';
import { IdentityProvider } from './ghost/identity.js';
import type { SocialWeb } from './ghost/types.js';
import { Queue, parseWhen } from './scheduler/queue.js';
import { Runner, watch } from './scheduler/runner.js';
import { createApp } from './shim/app.js';
import { OAuthServer } from './shim/oauth.js';
import { serve } from './shim/server.js';

const VERSION = '0.1.0';

const USAGE = `desk - a personal desk for a Ghost publication's Fediverse handle

  desk note <text> [--reply-to <id>] [--image <path>] [--alt <text>]
      Post immediately.

  desk queue add <text> --at <when> [--reply-to <id>] [--image <path>] [--alt <text>]
      Queue a note. <when> is "now", a relative offset such as "+2h" or "+3d",
      or an ISO timestamp.

  desk queue list [--all]      Show pending items, or every item with --all.
  desk queue rm <id>           Cancel a pending item.
  desk queue retry <id>        Return a failed item to the queue.

  desk run [--once] [--interval <seconds>]
      Publish everything that is due. Loops unless --once is given, so a cron
      entry wants --once and a long-running service does not.

  desk shim [--port <n>] [--host <addr>]
      Start the Mastodon-compatible bridge so publishing tools can log in.

  desk status                  Show who the handle is and whether auth works.

Global:
  --transport <ghst|direct>    Override DESK_TRANSPORT for this run.
  --help, --version
`;

interface Argv {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgv(argv: string[]): Argv {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }

  return { positional, flags };
}

function flagString(flags: Argv['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function buildSocialWeb(config: Config, override?: string): SocialWeb {
  const transport = override ?? config.transport;
  if (transport === 'direct') {
    const identity = new IdentityProvider(config.ghostUrl, config.staffToken);
    return new DirectSocialWeb(config.ghostUrl, identity);
  }
  return new GhstSocialWeb({ ghostUrl: config.ghostUrl, staffToken: config.staffToken });
}

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgv(argv);

  if (flags.help || positional.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  await loadDotEnv();
  const config = loadConfig();
  const transportOverride = flagString(flags, 'transport');
  const command = positional[0];

  switch (command) {
    case 'status':
      return status(config, transportOverride);
    case 'note':
      return note(config, positional.slice(1), flags, transportOverride);
    case 'queue':
      return queueCommand(config, positional.slice(1), flags);
    case 'run':
      return run(config, flags, transportOverride);
    case 'shim':
      return shim(config, flags);
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

async function status(config: Config, transport?: string): Promise<number> {
  const identity = new IdentityProvider(config.ghostUrl, config.staffToken);
  const { role, subject, expiresAt } = await identity.get();
  const social = buildSocialWeb(config, transport);
  const me = await social.me();

  process.stdout.write(
    [
      `site       ${config.ghostUrl}`,
      `identity   ${subject ?? 'unknown'} (${role ?? 'no role claim'})`,
      `token ttl  ${Math.round((expiresAt - Date.now()) / 1000)}s`,
      `handle     ${me.handle}`,
      `followers  ${me.followerCount ?? 0}`,
      `posts      ${me.postCount ?? 0}`,
      `transport  ${transport ?? config.transport}`,
      '',
    ].join('\n'),
  );
  return 0;
}

async function note(
  config: Config,
  args: string[],
  flags: Argv['flags'],
  transport?: string,
): Promise<number> {
  const content = args.join(' ').trim();
  if (!content) {
    process.stderr.write('Nothing to post.\n');
    return 2;
  }

  const social = buildSocialWeb(config, transport);
  const queue = Queue.open(config.dataDir);
  const item = await queue.add({
    content,
    publishAt: new Date(),
    ...pickNoteFlags(flags),
  });

  const runner = new Runner(queue, social, {
    onResult: (_item, result) => {
      if (result.ok) {
        process.stdout.write(`${result.postUrl}\n`);
      } else {
        process.stderr.write(`${result.error}\n`);
      }
    },
  });

  const { failed } = await runner.tick();
  const stored = await queue.get(item.id);
  return failed > 0 || stored?.status !== 'sent' ? 1 : 0;
}

function pickNoteFlags(flags: Argv['flags']): {
  replyTo?: string;
  imagePath?: string;
  imageAlt?: string;
} {
  const result: { replyTo?: string; imagePath?: string; imageAlt?: string } = {};
  const replyTo = flagString(flags, 'reply-to');
  const imagePath = flagString(flags, 'image');
  const imageAlt = flagString(flags, 'alt');
  if (replyTo) result.replyTo = replyTo;
  if (imagePath) result.imagePath = imagePath;
  if (imageAlt) result.imageAlt = imageAlt;
  return result;
}

async function queueCommand(
  config: Config,
  args: string[],
  flags: Argv['flags'],
): Promise<number> {
  const queue = Queue.open(config.dataDir);
  const subcommand = args[0];

  switch (subcommand) {
    case 'add': {
      const content = args.slice(1).join(' ').trim();
      const when = flagString(flags, 'at') ?? 'now';
      const item = await queue.add({
        content,
        publishAt: parseWhen(when),
        ...pickNoteFlags(flags),
      });
      process.stdout.write(`${item.id.slice(0, 8)}  ${item.publishAt}\n`);
      return 0;
    }
    case 'list': {
      const items = await queue.list({ all: Boolean(flags.all) });
      if (items.length === 0) {
        process.stdout.write('Nothing queued.\n');
        return 0;
      }
      for (const item of items) {
        const preview = item.content.replace(/\s+/g, ' ').slice(0, 58);
        process.stdout.write(
          `${item.id.slice(0, 8)}  ${item.publishAt}  ${item.status.padEnd(9)} ${preview}\n`,
        );
        if (item.lastError) process.stdout.write(`          ${item.lastError}\n`);
      }
      return 0;
    }
    case 'rm': {
      const id = args[1];
      if (!id) {
        process.stderr.write('Which item?\n');
        return 2;
      }
      const item = await queue.cancel(id);
      if (!item) {
        process.stderr.write(`No item matching "${id}".\n`);
        return 1;
      }
      process.stdout.write(`${item.id.slice(0, 8)} ${item.status}\n`);
      return item.status === 'cancelled' ? 0 : 1;
    }
    case 'retry': {
      const id = args[1];
      if (!id) {
        process.stderr.write('Which item?\n');
        return 2;
      }
      const item = await queue.retry(id);
      if (!item) {
        process.stderr.write(`No item matching "${id}".\n`);
        return 1;
      }
      process.stdout.write(`${item.id.slice(0, 8)} ${item.status}\n`);
      return 0;
    }
    default:
      process.stderr.write(`Unknown queue command "${subcommand ?? ''}".\n`);
      return 2;
  }
}

async function run(config: Config, flags: Argv['flags'], transport?: string): Promise<number> {
  const queue = Queue.open(config.dataDir);
  const social = buildSocialWeb(config, transport);
  const runner = new Runner(queue, social, {
    onResult: (item, result) => {
      const stamp = new Date().toISOString();
      if (result.ok) {
        process.stdout.write(`${stamp} sent ${item.id.slice(0, 8)} ${result.postUrl}\n`);
      } else {
        const suffix = result.willRetry ? 'will retry' : 'giving up';
        process.stderr.write(
          `${stamp} failed ${item.id.slice(0, 8)} (${suffix}): ${result.error}\n`,
        );
      }
    },
  });

  if (flags.once) {
    const { sent, failed } = await runner.tick();
    process.stdout.write(`sent ${sent}, failed ${failed}\n`);
    return failed > 0 ? 1 : 0;
  }

  const seconds = Number(flagString(flags, 'interval') ?? 60);
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());

  process.stdout.write(`Watching the queue every ${seconds}s. Ctrl-C to stop.\n`);
  await watch(runner, seconds * 1000, controller.signal);
  return 0;
}

async function shim(config: Config, flags: Argv['flags']): Promise<number> {
  if (!config.shim.password) {
    process.stderr.write(
      'SHIM_PASSWORD is not set. The bridge will not start without one: it is the only\n' +
        'thing standing between the open internet and posting rights on your publication.\n',
    );
    return 2;
  }

  const host = flagString(flags, 'host') ?? config.shim.host;
  const port = Number(flagString(flags, 'port') ?? config.shim.port);

  // The shim always talks to Ghost directly. Spawning a CLI per inbound request
  // would be a strange thing to do to a web server.
  const identity = new IdentityProvider(config.ghostUrl, config.staffToken);
  const social = new DirectSocialWeb(config.ghostUrl, identity);

  const handle = createApp({
    social,
    oauth: OAuthServer.open(config.dataDir, config.shim.password),
    queue: Queue.open(config.dataDir),
    publicUrl: config.shim.publicUrl,
    version: VERSION,
    ghostUrl: config.ghostUrl,
  });

  serve({
    host,
    port,
    handle,
    onListening: (address) => {
      process.stdout.write(
        [
          `Bridge listening on http://${address.host}:${address.port}`,
          `Clients should be pointed at ${config.shim.publicUrl}`,
          host === '127.0.0.1' || host === 'localhost'
            ? 'Bound to loopback. Put a TLS proxy in front before any real client uses it.'
            : 'Bound to a public interface. Make sure TLS and a firewall are in front of it.',
          '',
        ].join('\n'),
      );
    },
  });

  return new Promise<number>((resolve) => {
    const stop = () => resolve(0);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
