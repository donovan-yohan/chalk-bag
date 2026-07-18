import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  buildSystemdUnit,
  installSystemdUnit,
  reloadSystemdUnit,
  uninstallSystemdUnit,
  getSystemdActiveState,
  SYSTEMD_UNIT_NAME,
  type ExecFn,
  type SystemctlResult,
} from '../src/daemon/systemd.js';
import { getSystemdUnitPath, touchHeartbeat } from '../src/daemon/registry.js';
import {
  installDaemon,
  uninstallDaemon,
  reloadDaemon,
  getDaemonStatus,
  describeServiceManager,
} from '../src/daemon/service.js';
import { ChalkBagError } from '../src/types.js';

const defaultOptions = {
  nodePath: '/usr/local/bin/node',
  entryPath: '/usr/local/lib/chalkbag/dist/daemon/entry.js',
  configHome: '/home/testuser/.config/chalkbag',
};

// ---------------------------------------------------------------------------
// A spawn-recording exec seam: records every systemctl call and returns a
// caller-controlled result. No real `systemctl` is ever invoked.
// ---------------------------------------------------------------------------

type RecordedCall = { file: string; args: string[] };

function makeExec(
  handler: (args: string[]) => SystemctlResult = () => ({ status: 0, stdout: '', stderr: '' }),
): { exec: ExecFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: ExecFn = (file, args) => {
    calls.push({ file, args });
    return handler(args);
  };
  return { exec, calls };
}

const argvOf = (calls: RecordedCall[]): string[][] => calls.map((c) => c.args);

/** Runs an async fn and returns the thrown ChalkBagError (fails otherwise). */
async function captureChalkBagError(fn: () => Promise<unknown>): Promise<ChalkBagError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ChalkBagError);
    return error as ChalkBagError;
  }
  throw new Error('expected the call to throw a ChalkBagError, but it resolved');
}

// ---------------------------------------------------------------------------
// buildSystemdUnit — required content
// ---------------------------------------------------------------------------

describe('buildSystemdUnit — required content', () => {
  it('runs node + the daemon entry in ExecStart (systemd-quoted)', () => {
    const unit = buildSystemdUnit(defaultOptions);
    expect(unit).toContain(
      'ExecStart="/usr/local/bin/node" "/usr/local/lib/chalkbag/dist/daemon/entry.js"',
    );
  });

  it('passes CHALKBAG_CONFIG_HOME via Environment= (systemd-quoted)', () => {
    const unit = buildSystemdUnit(defaultOptions);
    expect(unit).toContain('Environment=CHALKBAG_CONFIG_HOME="/home/testuser/.config/chalkbag"');
  });

  it('sets Restart=always (KeepAlive parity) with a RestartSec backoff', () => {
    const unit = buildSystemdUnit(defaultOptions);
    expect(unit).toContain('Restart=always');
    expect(unit).toMatch(/RestartSec=\d+/);
  });

  it('is a [Service] unit wanted by default.target', () => {
    const unit = buildSystemdUnit(defaultOptions);
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('documents journal logging (no explicit StandardOutput path)', () => {
    const unit = buildSystemdUnit(defaultOptions);
    expect(unit).toContain('journalctl --user -u chalkbag.service');
    expect(unit).not.toContain('StandardOutput=');
    expect(unit).not.toContain('.log');
  });
});

// ---------------------------------------------------------------------------
// configHome validation (eng M-1 parity)
// ---------------------------------------------------------------------------

describe('buildSystemdUnit — configHome validation (eng M-1)', () => {
  it('throws ChalkBagError when configHome is a relative path', () => {
    expect(() => buildSystemdUnit({ ...defaultOptions, configHome: 'relative/path' })).toThrow(
      ChalkBagError,
    );
    expect(() => buildSystemdUnit({ ...defaultOptions, configHome: 'relative/path' })).toThrow(
      'must be an absolute path',
    );
  });

  it('throws when configHome contains a newline (directive injection guard)', () => {
    expect(() =>
      buildSystemdUnit({ ...defaultOptions, configHome: '/valid\nExecStartPre=/evil' }),
    ).toThrow('control characters');
  });

  it('throws when configHome contains a null byte', () => {
    expect(() => buildSystemdUnit({ ...defaultOptions, configHome: '/valid/path\x00oops' })).toThrow(
      ChalkBagError,
    );
  });

  it('throws when nodePath contains a newline', () => {
    expect(() =>
      buildSystemdUnit({ ...defaultOptions, nodePath: '/bin/node\nExecStart=/evil' }),
    ).toThrow(ChalkBagError);
  });

  it('accepts a normal absolute path', () => {
    expect(() =>
      buildSystemdUnit({ ...defaultOptions, configHome: '/home/alice/.config/chalkbag' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// systemd specifier escaping (% -> %%)
// ---------------------------------------------------------------------------

describe('buildSystemdUnit — specifier escaping', () => {
  it('escapes a literal % to %% so systemd does not expand it', () => {
    const unit = buildSystemdUnit({ ...defaultOptions, configHome: '/home/50%/chalkbag' });
    expect(unit).toContain('Environment=CHALKBAG_CONFIG_HOME="/home/50%%/chalkbag"');
    expect(unit).not.toContain('/home/50%/chalkbag');
  });
});

// ---------------------------------------------------------------------------
// systemd double-quoting (space-containing / special-char paths)
// ---------------------------------------------------------------------------

describe('buildSystemdUnit — path quoting', () => {
  it('quotes each ExecStart argument and the Environment value so a space does not mis-split', () => {
    const unit = buildSystemdUnit({
      nodePath: '/opt/my node/bin/node',
      entryPath: '/opt/chalk bag/dist/daemon/entry.js',
      configHome: '/home/my user/.config/chalkbag',
    });
    expect(unit).toContain(
      'ExecStart="/opt/my node/bin/node" "/opt/chalk bag/dist/daemon/entry.js"',
    );
    expect(unit).toContain('Environment=CHALKBAG_CONFIG_HOME="/home/my user/.config/chalkbag"');
  });

  it('escapes embedded backslashes and double quotes inside the quoted value', () => {
    // Original path: /home/a"b\c/chalkbag  -> inside quotes: /home/a\"b\\c/chalkbag
    const unit = buildSystemdUnit({ ...defaultOptions, configHome: '/home/a"b\\c/chalkbag' });
    expect(unit).toContain('Environment=CHALKBAG_CONFIG_HOME="/home/a\\"b\\\\c/chalkbag"');
  });
});

// ---------------------------------------------------------------------------
// Full rendered unit (snapshot equivalent)
// ---------------------------------------------------------------------------

describe('buildSystemdUnit — full render', () => {
  it('renders the expected unit file', () => {
    const unit = buildSystemdUnit({
      nodePath: '/usr/local/bin/node',
      entryPath: '/usr/local/lib/chalkbag/dist/daemon/entry.js',
      configHome: '/home/alice/.config/chalkbag',
    });

    expect(unit).toBe(
      `[Unit]
Description=chalkbag daemon (compiles .chalk/ into provider configs)
Documentation=https://github.com/donovan-yohan/chalk-bag
After=default.target

[Service]
Type=simple
ExecStart="/usr/local/bin/node" "/usr/local/lib/chalkbag/dist/daemon/entry.js"
Environment=CHALKBAG_CONFIG_HOME="/home/alice/.config/chalkbag"
Restart=always
RestartSec=10
# stdout and stderr are captured by the systemd journal:
#   journalctl --user -u chalkbag.service

[Install]
WantedBy=default.target
`,
    );
  });
});

// ---------------------------------------------------------------------------
// install / reload / uninstall command sequences (mocked exec + tmp XDG dir)
// ---------------------------------------------------------------------------

describe('systemd lifecycle — command sequences', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chalkbag-systemd-test-'));
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    process.env['CHALKBAG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    delete process.env['XDG_CONFIG_HOME'];
    delete process.env['CHALKBAG_CONFIG_HOME'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('install probes the bus, writes the unit, daemon-reloads, then enables --now', async () => {
    const { exec, calls } = makeExec();
    await installSystemdUnit(buildSystemdUnit(defaultOptions), exec);

    expect(argvOf(calls)).toEqual([
      ['--user', 'is-system-running'],
      ['--user', 'daemon-reload'],
      ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
    ]);

    const written = fs.readFileSync(getSystemdUnitPath(), 'utf8');
    expect(written).toContain('Restart=always');
  });

  it('writes the unit under XDG_CONFIG_HOME/systemd/user/', async () => {
    const { exec } = makeExec();
    await installSystemdUnit(buildSystemdUnit(defaultOptions), exec);
    expect(getSystemdUnitPath()).toBe(
      path.join(tmpDir, 'systemd', 'user', 'chalkbag.service'),
    );
    expect(fs.existsSync(getSystemdUnitPath())).toBe(true);
  });

  it('reload rewrites the unit, daemon-reloads, then restarts', async () => {
    const { exec, calls } = makeExec();
    await reloadSystemdUnit(buildSystemdUnit(defaultOptions), exec);

    expect(argvOf(calls)).toEqual([
      ['--user', 'is-system-running'],
      ['--user', 'daemon-reload'],
      ['--user', 'restart', SYSTEMD_UNIT_NAME],
    ]);
    expect(fs.existsSync(getSystemdUnitPath())).toBe(true);
  });

  it('uninstall disables --now, removes the unit, then daemon-reloads', async () => {
    // Seed a unit file to remove.
    fs.mkdirSync(path.dirname(getSystemdUnitPath()), { recursive: true });
    fs.writeFileSync(getSystemdUnitPath(), buildSystemdUnit(defaultOptions));

    const { exec, calls } = makeExec();
    await uninstallSystemdUnit(exec);

    expect(argvOf(calls)).toEqual([
      ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME],
      ['--user', 'daemon-reload'],
    ]);
    expect(fs.existsSync(getSystemdUnitPath())).toBe(false);
  });

  it('install throws an actionable error when the user session bus is down', async () => {
    const busDown: ExecFn = (_file, args) => {
      if (args.includes('is-system-running')) {
        return { status: 1, stdout: 'offline\n', stderr: 'Failed to connect to bus: No medium found' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const error = await captureChalkBagError(() =>
      installSystemdUnit(buildSystemdUnit(defaultOptions), busDown),
    );
    expect(error.message).toContain('user session is unavailable');
    expect(error.fix).toMatch(/loginctl enable-linger/);
    expect(error.fix).toMatch(/chalkbag watch/);
    // The probe failed before anything was written.
    expect(fs.existsSync(getSystemdUnitPath())).toBe(false);
  });

  it('install surfaces a failing systemctl command as a ChalkBagError', async () => {
    const enableFails: ExecFn = (_file, args) => {
      if (args.includes('enable')) {
        return { status: 1, stdout: '', stderr: 'Failed to enable unit' };
      }
      return { status: 0, stdout: 'running', stderr: '' };
    };
    await expect(installSystemdUnit(buildSystemdUnit(defaultOptions), enableFails)).rejects.toThrow(
      /systemctl --user enable --now .* failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// getSystemdActiveState — is-active parsing
// ---------------------------------------------------------------------------

describe('getSystemdActiveState', () => {
  it('returns the trimmed is-active state', () => {
    const { exec } = makeExec(() => ({ status: 0, stdout: 'active\n', stderr: '' }));
    expect(getSystemdActiveState(exec)).toBe('active');
  });

  it('returns inactive when the unit is stopped', () => {
    const { exec, calls } = makeExec(() => ({ status: 3, stdout: 'inactive\n', stderr: '' }));
    expect(getSystemdActiveState(exec)).toBe('inactive');
    expect(argvOf(calls)).toEqual([['--user', 'is-active', SYSTEMD_UNIT_NAME]]);
  });

  it('returns unknown when systemctl is unavailable (null exit)', () => {
    const { exec } = makeExec(() => ({ status: null, stdout: '', stderr: '' }));
    expect(getSystemdActiveState(exec)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// service.ts dispatch — platform selection, unsupported error, status merge
// ---------------------------------------------------------------------------

describe('service dispatch', () => {
  const originalPlatform = process.platform;
  let tmpDir: string;

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chalkbag-service-test-'));
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    process.env['CHALKBAG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    delete process.env['XDG_CONFIG_HOME'];
    delete process.env['CHALKBAG_CONFIG_HOME'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('describes systemd on linux and launchd on darwin', () => {
    setPlatform('linux');
    expect(describeServiceManager().manager).toBe('systemd');
    setPlatform('darwin');
    expect(describeServiceManager().manager).toBe('launchd');
  });

  it('install on an unsupported platform errors and names `chalkbag watch`', async () => {
    setPlatform('win32');
    for (const call of [installDaemon, reloadDaemon, uninstallDaemon]) {
      const error = await captureChalkBagError(() => call());
      expect(error.message).toContain('not supported on platform "win32"');
      expect(error.fix).toMatch(/chalkbag watch/);
    }
  });

  it('status merges is-active with heartbeat freshness (fresh)', async () => {
    setPlatform('linux');
    await touchHeartbeat(Date.now());
    const { exec } = makeExec((args) =>
      args.includes('is-active')
        ? { status: 0, stdout: 'active\n', stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
    );

    const status = await getDaemonStatus(exec);
    expect(status.platform).toBe('linux');
    expect(status.manager).toBe('systemd');
    expect(status.active).toBe('active');
    expect(status.heartbeatStale).toBe(false);
    expect(status.paused).toBe(false);
    expect(status.unitPath).toBe(path.join(tmpDir, 'systemd', 'user', 'chalkbag.service'));
  });

  it('status reports a stale heartbeat when none was written', async () => {
    setPlatform('linux');
    const { exec } = makeExec(() => ({ status: 3, stdout: 'inactive\n', stderr: '' }));
    const status = await getDaemonStatus(exec);
    expect(status.active).toBe('inactive');
    expect(status.heartbeatStale).toBe(true);
  });

  it('status on an unsupported platform points at `chalkbag watch`', async () => {
    setPlatform('win32');
    const status = await getDaemonStatus();
    expect(status.manager).toBeNull();
    expect(status.unitPath).toBeNull();
    expect(status.active).toContain('chalkbag watch');
  });
});
