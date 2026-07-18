#!/usr/bin/env node
// Note: shebang is preserved in TypeScript emit when placed before imports.
import { cac } from 'cac';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

import {
  readRegistry,
  addPath,
  removePath,
  findPathFor,
  getConfigHome,
  getRegistryPath,
  getHeartbeatPath,
  getLogDir,
  getPauseFlagPath,
  isHeartbeatStale,
  readHeartbeat,
  hasPauseFlag,
} from './daemon/registry.js';
import {
  installDaemon,
  reloadDaemon,
  uninstallDaemon,
  getDaemonStatus,
  describeServiceManager,
} from './daemon/service.js';
import { buildAgentsRepo } from './render.js';
import { watchAgentsRepo } from './watcher.js';
import { scaffoldRepo } from './commands/scaffold.js';
import {
  buildGlobalScope,
  cleanGlobalScope,
  scaffoldGlobal,
  validateGlobalScope,
} from './global.js';
import { resolveGlobalScope } from './scope.js';
import { validateAgentsRepo } from './spec/validate.js';
import { importAgentsRepo } from './importer.js';
import { runGitHook } from './hooks.js';
import { providerIds, providerGeneratedArtifactEntries } from './providers/registry.js';
import type { ProviderId } from './providers/registry.js';
import { ChalkBagError, formatError } from './types.js';

// Suppress unused import warning — createRequire is used inside readPackageVersion
void createRequire;

/**
 * cac matches commands by the first positional arg only, so multi-word
 * commands like `daemon status` must be joined into a single token for
 * matching. We preprocess argv here, then register identical single-token
 * commands so both `--help` and dispatch work correctly.
 *
 * Known two-word command prefixes that need joining:
 */
const TWO_WORD_COMMANDS = new Set([
  'daemon install',
  'daemon status',
  'daemon reload',
  'daemon uninstall',
  'daemon pause',
  'daemon resume',
  'cache clear',
  'internal hook-run',
  'register-group', // single-word, but has a hyphen — keep for completeness
]);

/**
 * Joins known two-word command tokens in argv so cac can match them.
 * `['node', 'cli.js', 'daemon', 'status']` → `['node', 'cli.js', 'daemon status']`
 */
function normalizeArgv(argv: string[]): string[] {
  if (argv.length < 4) return argv;
  // argv[0] = node, argv[1] = script, argv[2+] = user args
  const prefix = argv.slice(0, 2);
  const args = argv.slice(2);
  if (args.length >= 2) {
    const twoWord = `${args[0]} ${args[1]}`;
    if (TWO_WORD_COMMANDS.has(twoWord)) {
      return [...prefix, twoWord, ...args.slice(2)];
    }
  }
  return argv;
}

function parseProviders(input: string | string[] | undefined): ProviderId[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : [input];
  // Each element may itself be comma-separated (e.g. --provider claude,codex)
  const ids = raw.flatMap((v) => v.split(',').map((s) => s.trim())).filter(Boolean);
  const invalid = ids.filter((id) => !providerIds.includes(id as ProviderId));
  if (invalid.length > 0) {
    throw new ChalkBagError({
      kind: 'cli',
      file: invalid[0],
      message: `unknown provider id: ${invalid.join(', ')}`,
      fix: `valid providers are: ${providerIds.join(', ')}`,
    });
  }
  return ids as ProviderId[];
}

/**
 * Machine-level `chalkbag init --global`: scaffold ~/.chalk/, register the
 * global scope with the daemon, and run the first build.
 */
async function runGlobalInit(installDaemonFlag?: boolean): Promise<void> {
  const scaffold = await scaffoldGlobal();

  // register (global mode) — idempotent
  try {
    await addPath({ path: scaffold.home, mode: 'global', providers: ['claude', 'codex'], ignore: [] });
  } catch (e) {
    if (e instanceof ChalkBagError && /already registered/.test(e.message)) {
      // idempotent — not an error
    } else {
      throw e;
    }
  }

  const result = await buildGlobalScope({});

  console.log(`chalkbag init --global: scaffolded ${scaffold.agentsRoot}`);
  console.log(`  created: ${scaffold.created.length > 0 ? scaffold.created.join(', ') : '(none)'}`);
  console.log(`  registered: ${scaffold.home} (mode: global, providers: claude, codex)`);
  console.log(`  linked: ${result.linked.length > 0 ? result.linked.join(', ') : '(none)'}`);
  for (const warning of result.warnings) {
    console.warn(`  warning: ${warning}`);
  }
  console.log(`  next: edit ${path.join(scaffold.agentsRoot, 'AGENTS.md')}, then \`chalkbag build --global\``);

  if (installDaemonFlag) {
    const { manager, unitPath } = await installDaemon();
    console.log(`  daemon: installed via ${manager} (${unitPath})`);
  }
}

async function pathExistsSafe(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageVersion(): Promise<string> {
  const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json');
  try {
    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8')) as Record<string, unknown>;
    return typeof pkg['version'] === 'string' ? pkg['version'] : '0.0.0';
  } catch {
    return 'unknown';
  }
}

async function main() {
  const cli = cac('chalkbag');

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------
  cli
    .command('init [path]', 'Scaffold .chalk/, register cwd, run first build')
    .option('--provider <ids>', 'Providers (repeatable or comma-separated)')
    .option('--global', 'Scaffold + build the machine-level ~/.chalk/ scope instead of a repo')
    .option('--daemon', 'Also install the background daemon (launchd on macOS, systemd on Linux)')
    .action(async (targetPath: string | undefined, options: { provider?: string | string[]; global?: boolean; daemon?: boolean }) => {
      if (options.global) {
        await runGlobalInit(options.daemon);
        return;
      }
      const resolved = path.resolve(targetPath ?? process.cwd());
      const providers =
        parseProviders(options.provider).length > 0
          ? parseProviders(options.provider)
          : [...providerIds];

      // scaffold
      const scaffoldResult = await scaffoldRepo(resolved, { providers });

      // register (repo mode) — idempotent
      try {
        await addPath({ path: resolved, mode: 'repo', providers, ignore: [] });
      } catch (e) {
        if (e instanceof ChalkBagError && /already registered/.test(e.message)) {
          // idempotent — not an error
        } else {
          throw e;
        }
      }

      // synchronous first build (DX M-1)
      await buildAgentsRepo(resolved, { force: true, yes: true, providers });

      // print confirmation
      const outputs = providers
        .map((id) => {
          if (id === 'claude') return '.claude/';
          if (id === 'codex') return '.codex/';
          if (id === 'opencode') return 'opencode.json, .opencode/';
          return '';
        })
        .filter(Boolean)
        .join(', ');

      console.log(`chalkbag init: scaffolded .chalk/ at ${resolved}`);
      console.log(
        `  created: ${scaffoldResult.created.length > 0 ? scaffoldResult.created.join(', ') : '(none)'}`,
      );
      console.log(`  registered: ${resolved} (mode: repo, providers: ${providers.join(', ')})`);
      console.log(`  rendered: ${outputs}`);
      console.log(`  next: edit AGENTS.md, then \`chalkbag build\` to re-render`);

      if (options.daemon) {
        const { manager, unitPath } = await installDaemon();
        console.log(`  daemon: installed via ${manager} (${unitPath})`);
      } else {
        console.log(
          `  daemon: not installed — run \`chalkbag daemon install\` to enable`,
        );
      }
    });

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------
  cli
    .command('register [path]', 'Register a path for watching')
    .option('--parent', 'Parent mode — scan 1 level deep for repos with .chalk/')
    .option('--provider <ids>', 'Providers')
    .option('--ignore <glob>', 'Ignore glob (repeatable)')
    .action(
      async (
        targetPath: string | undefined,
        options: { parent?: boolean; provider?: string | string[]; ignore?: string | string[] },
      ) => {
        const resolved = path.resolve(targetPath ?? process.cwd());
        const providers =
          parseProviders(options.provider).length > 0
            ? parseProviders(options.provider)
            : [...providerIds];
        const ignoreList: string[] = Array.isArray(options.ignore)
          ? options.ignore
          : options.ignore
            ? [options.ignore]
            : [];
        await addPath({
          path: resolved,
          mode: options.parent ? 'parent' : 'repo',
          providers,
          ignore: ignoreList,
        });
        console.log(
          `chalkbag register: ${resolved} (mode: ${options.parent ? 'parent' : 'repo'}, providers: ${providers.join(', ')})`,
        );
      },
    );

  // -------------------------------------------------------------------------
  // register-group
  // -------------------------------------------------------------------------
  cli
    .command('register-group [path]', 'Alias for `register --parent`')
    .option('--provider <ids>', 'Providers')
    .option('--ignore <glob>', 'Ignore glob (repeatable)')
    .action(
      async (
        targetPath: string | undefined,
        options: { provider?: string | string[]; ignore?: string | string[] },
      ) => {
        const resolved = path.resolve(targetPath ?? process.cwd());
        const providers =
          parseProviders(options.provider).length > 0
            ? parseProviders(options.provider)
            : [...providerIds];
        const ignoreList: string[] = Array.isArray(options.ignore)
          ? options.ignore
          : options.ignore
            ? [options.ignore]
            : [];
        await addPath({
          path: resolved,
          mode: 'parent',
          providers,
          ignore: ignoreList,
        });
        console.log(
          `chalkbag register-group: ${resolved} (parent, providers: ${providers.join(', ')})`,
        );
      },
    );

  // -------------------------------------------------------------------------
  // unregister
  // -------------------------------------------------------------------------
  cli
    .command('unregister [path]', 'Unregister a path')
    .action(async (targetPath: string | undefined) => {
      const resolved = path.resolve(targetPath ?? process.cwd());
      const removed = await removePath(resolved);
      if (removed) {
        console.log(`chalkbag unregister: removed ${resolved}`);
      } else {
        console.log(`chalkbag unregister: no entry for ${resolved}`);
      }
    });

  // -------------------------------------------------------------------------
  // paths
  // -------------------------------------------------------------------------
  cli.command('paths', 'List registered paths as JSON').action(async () => {
    const registry = await readRegistry();
    console.log(JSON.stringify({ version: registry.version, paths: registry.paths }, null, 2));
  });

  // -------------------------------------------------------------------------
  // doctor
  // -------------------------------------------------------------------------
  cli.command('doctor', 'Report config paths, heartbeat, daemon status').action(async () => {
    const registry = await readRegistry();
    const paused = await hasPauseFlag();
    const heartbeatMs = await readHeartbeat();
    const stale = await isHeartbeatStale();
    const service = describeServiceManager();
    // findPathFor is available if needed; suppress unused warning by referencing in output
    const currentEntry = await findPathFor(process.cwd());

    // Global scope status, reported distinctly from repo/parent entries.
    const globalScope = resolveGlobalScope();
    const globalEntry = registry.paths.find((entry) => entry.mode === 'global') ?? null;
    const globalStatus = {
      home: globalScope.sourceRoot,
      agentsRoot: globalScope.agentsRoot,
      sourceExists: await pathExistsSafe(globalScope.agentsRoot),
      registered: globalEntry !== null,
      providers: globalEntry?.providers ?? [],
    };

    console.log(
      JSON.stringify(
        {
          version: registry.version,
          pathCount: registry.paths.length,
          configHome: getConfigHome(),
          global: globalStatus,
          registryPath: getRegistryPath(),
          heartbeatPath: getHeartbeatPath(),
          logDir: getLogDir(),
          platform: service.platform,
          serviceManager: service.manager,
          servicePath: service.unitPath,
          pauseFlagPath: getPauseFlagPath(),
          paused,
          heartbeatStale: stale,
          heartbeatAt: heartbeatMs !== null ? new Date(heartbeatMs).toISOString() : null,
          currentDir: process.cwd(),
          currentDirEntry: currentEntry ?? null,
          paths: registry.paths,
        },
        null,
        2,
      ),
    );
  });

  // -------------------------------------------------------------------------
  // scaffold
  // -------------------------------------------------------------------------
  cli
    .command('scaffold [path]', 'Bootstrap .chalk/ from template')
    .option('--provider <ids>', 'Providers')
    .action(
      async (targetPath: string | undefined, options: { provider?: string | string[] }) => {
        const resolved = path.resolve(targetPath ?? process.cwd());
        const providers =
          parseProviders(options.provider).length > 0
            ? parseProviders(options.provider)
            : undefined;
        const result = await scaffoldRepo(resolved, { providers });
        console.log(`chalkbag scaffold: ok (${resolved})`);
        if (result.created.length > 0) {
          console.log(`  created: ${result.created.join(', ')}`);
        }
        if (result.skipped.length > 0) {
          console.log(`  skipped (already exist): ${result.skipped.join(', ')}`);
        }
        if (result.created.length === 0 && result.skipped.length === 0) {
          console.log(`  nothing to do`);
        }
      },
    );

  // -------------------------------------------------------------------------
  // build
  // -------------------------------------------------------------------------
  cli
    .command('build [path]', 'One-shot render')
    .option('--provider <ids>', 'Providers')
    .option('--global', 'Build the machine-level ~/.chalk/ scope')
    .option('--yes', 'Auto-apply gitignore updates')
    .option('--force', 'Bypass daemon heartbeat stale check')
    .action(
      async (
        targetPath: string | undefined,
        options: { provider?: string | string[]; global?: boolean; yes?: boolean; force?: boolean },
      ) => {
        if (options.global) {
          const providers = parseProviders(options.provider);
          const result = await buildGlobalScope({
            providers: providers.length > 0 ? providers : undefined,
          });
          console.log(`chalkbag build --global: ok`);
          if (result.linked.length > 0) {
            console.log(`  linked: ${result.linked.join(', ')}`);
          }
          for (const warning of result.warnings) {
            console.warn(warning);
          }
          return;
        }
        const resolved = path.resolve(targetPath ?? process.cwd());
        const providers =
          parseProviders(options.provider).length > 0
            ? parseProviders(options.provider)
            : undefined;
        const result = await buildAgentsRepo(resolved, {
          providers,
          yes: options.yes,
          force: options.force,
        });
        console.log(`chalkbag build: ok`);
        if (result.warnings.length > 0) {
          for (const warning of result.warnings) {
            console.warn(warning);
          }
        }
      },
    );

  // -------------------------------------------------------------------------
  // watch
  // -------------------------------------------------------------------------
  cli
    .command('watch [path]', 'Inline watcher fallback')
    .option('--provider <ids>', 'Providers')
    .action(async (targetPath: string | undefined, options: { provider?: string | string[] }) => {
      console.log(
        'chalkbag watch: inline fallback (no daemon). Use `chalkbag daemon install` for background watching.',
      );
      const providers =
        parseProviders(options.provider).length > 0 ? parseProviders(options.provider) : undefined;
      await watchAgentsRepo(path.resolve(targetPath ?? process.cwd()), { providers });
    });

  // -------------------------------------------------------------------------
  // validate
  // -------------------------------------------------------------------------
  cli
    .command('validate [path]', 'Validate a .chalk/ tree')
    .option('--global', 'Validate the machine-level ~/.chalk/ scope')
    .action(async (targetPath: string | undefined, options: { global?: boolean }) => {
      if (options.global) {
        await validateGlobalScope();
        console.log('chalkbag validate --global: ok');
        return;
      }
      await validateAgentsRepo(path.resolve(targetPath ?? process.cwd()));
      console.log('chalkbag validate: ok');
    });

  // -------------------------------------------------------------------------
  // cache clear
  // -------------------------------------------------------------------------
  cli.command('cache clear', 'Clear external-imports cache').action(async () => {
    const cacheRoot = path.join(
      process.env['HOME'] ?? '/tmp',
      '.cache',
      'chalkbag',
      'imports',
    );
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
    console.log(`chalkbag cache clear: ${cacheRoot} cleared`);
  });

  // -------------------------------------------------------------------------
  // clean
  // -------------------------------------------------------------------------
  cli
    .command('clean [path]', 'Remove generated provider outputs')
    .option('--global', 'Clean the machine-level ~/.chalk/ outputs (never the user config files)')
    .action(async (targetPath: string | undefined, options: { global?: boolean }) => {
      if (options.global) {
        const result = await cleanGlobalScope();
        console.log(`chalkbag clean --global: ${result.home}`);
        console.log(`  removed: ${result.removed.length > 0 ? result.removed.join(', ') : '(none)'}`);
        if (result.preserved.length > 0) {
          console.log(`  preserved (your config): ${result.preserved.join(', ')}`);
        }
        return;
      }
      const resolved = path.resolve(targetPath ?? process.cwd());
      for (const entry of providerGeneratedArtifactEntries) {
        const stripped = entry.replace(/^\//, ''); // "/.claude/" -> ".claude/"
        const targetFile = path.join(resolved, stripped);
        await fs.promises.rm(targetFile, { recursive: true, force: true });
      }
      console.log(`chalkbag clean: removed generated outputs in ${resolved}`);
    });

  // -------------------------------------------------------------------------
  // import
  // -------------------------------------------------------------------------
  cli.command('import [path]', 'Import legacy provider files into .chalk/').action(
    async (targetPath: string | undefined) => {
      await importAgentsRepo(path.resolve(targetPath ?? process.cwd()));
    },
  );

  // -------------------------------------------------------------------------
  // daemon subcommands
  // -------------------------------------------------------------------------
  cli
    .command('daemon install', 'Install the background daemon (launchd on macOS, systemd on Linux)')
    .action(async () => {
      const { manager, unitPath } = await installDaemon();
      console.log(`chalkbag daemon install: ${manager} (${unitPath})`);
    });

  cli.command('daemon status', 'Report daemon + heartbeat').action(async () => {
    const status = await getDaemonStatus();
    console.log(JSON.stringify(status, null, 2));
  });

  cli.command('daemon reload', 'Rewrite the unit/plist and reload').action(async () => {
    await reloadDaemon();
    console.log('chalkbag daemon reload: ok');
  });

  cli.command('daemon uninstall', 'Stop and remove the daemon unit/plist').action(async () => {
    await uninstallDaemon();
    console.log('chalkbag daemon uninstall: ok');
  });

  cli.command('daemon pause', 'Pause the daemon without uninstalling').action(async () => {
    const p = getPauseFlagPath();
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, `${new Date().toISOString()}\n`, 'utf8');
    console.log(`chalkbag daemon pause: flag written to ${p}`);
    console.log(
      `  daemon will skip watcher startup on next reload; run \`chalkbag daemon reload\` to apply immediately`,
    );
  });

  cli.command('daemon resume', 'Clear the pause flag').action(async () => {
    const p = getPauseFlagPath();
    await fs.promises.rm(p, { force: true });
    console.log(`chalkbag daemon resume: flag cleared`);
  });

  // -------------------------------------------------------------------------
  // internal hook-run (hidden from --help via naming convention)
  // -------------------------------------------------------------------------
  cli
    .command('internal hook-run [path]', 'Internal git hook entry')
    .action(async (targetPath: string | undefined) => {
      const result = await runGitHook(path.resolve(targetPath ?? process.cwd()));
      if (result.warning) {
        console.error(result.warning);
      }
    });

  cli.version(await readPackageVersion());
  cli.help();
  const normalizedArgv = normalizeArgv(process.argv);
  cli.parse(normalizedArgv, { run: false });

  // Detect unknown commands: if user supplied a positional arg but nothing matched,
  // print an error and exit non-zero.
  if (!cli.matchedCommand) {
    const userArg = normalizedArgv[2];
    if (userArg && !userArg.startsWith('-')) {
      console.error(`chalkbag: unknown command: ${userArg}`);
      console.error(`run \`chalkbag --help\` for usage`);
      process.exit(1);
    }
  }

  await cli.runMatchedCommand();
}

main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exit(1);
});
