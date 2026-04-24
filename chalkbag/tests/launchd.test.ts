import { describe, it, expect } from 'vitest';

import { buildLaunchdPlist } from '../src/daemon/launchd.js';
import { ChalkBagError } from '../src/types.js';

const defaultOptions = {
  nodePath: '/usr/local/bin/node',
  tsxPath: '/usr/local/bin/tsx',
  entryPath: '/usr/local/lib/chalkbag/dist/daemon/entry.js',
  configHome: '/Users/testuser/.config/chalkbag',
};

// ---------------------------------------------------------------------------
// Label + env var presence
// ---------------------------------------------------------------------------

describe('buildLaunchdPlist — required content', () => {
  it('contains com.chalkbag.daemon as the label', () => {
    const plist = buildLaunchdPlist(defaultOptions);
    expect(plist).toContain('<string>com.chalkbag.daemon</string>');
  });

  it('contains CHALKBAG_CONFIG_HOME as an environment variable key', () => {
    const plist = buildLaunchdPlist(defaultOptions);
    expect(plist).toContain('<key>CHALKBAG_CONFIG_HOME</key>');
  });

  it('embeds the configHome value in the EnvironmentVariables dict', () => {
    const plist = buildLaunchdPlist(defaultOptions);
    expect(plist).toContain('<string>/Users/testuser/.config/chalkbag</string>');
  });

  it('references chalkbag.log (not xt-agents.log)', () => {
    const plist = buildLaunchdPlist(defaultOptions);
    expect(plist).toContain('chalkbag.log');
    expect(plist).not.toContain('xt-agents.log');
  });

  it('is valid-looking XML with a plist root', () => {
    const plist = buildLaunchdPlist(defaultOptions);
    expect(plist).toMatch(/^<\?xml version="1\.0"/);
    expect(plist).toContain('<plist version="1.0">');
    expect(plist).toContain('</plist>');
  });

  it('embeds nodePath, tsxPath, entryPath in ProgramArguments', () => {
    const plist = buildLaunchdPlist(defaultOptions);
    expect(plist).toContain(defaultOptions.nodePath);
    expect(plist).toContain(defaultOptions.tsxPath);
    expect(plist).toContain(defaultOptions.entryPath);
  });

  it('has KeepAlive/SuccessfulExit set to false', () => {
    const plist = buildLaunchdPlist(defaultOptions);
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
  });
});

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

describe('buildLaunchdPlist — XML escaping', () => {
  it('escapes & in paths', () => {
    const plist = buildLaunchdPlist({ ...defaultOptions, entryPath: '/path/with&ampersand/entry.js' });
    expect(plist).toContain('&amp;');
    expect(plist).not.toContain('/path/with&ampersand/');
  });

  it('escapes < in paths', () => {
    const plist = buildLaunchdPlist({ ...defaultOptions, entryPath: '/path/with<bracket/entry.js' });
    expect(plist).toContain('&lt;');
  });

  it('escapes > in paths', () => {
    const plist = buildLaunchdPlist({ ...defaultOptions, entryPath: '/path/with>bracket/entry.js' });
    expect(plist).toContain('&gt;');
  });

  it('escapes double quotes in configHome', () => {
    const plist = buildLaunchdPlist({ ...defaultOptions, configHome: '/path/with"quote' });
    expect(plist).toContain('&quot;');
  });

  it('escapes single quotes in configHome', () => {
    const plist = buildLaunchdPlist({ ...defaultOptions, configHome: "/path/with'quote" });
    expect(plist).toContain('&apos;');
  });
});

// ---------------------------------------------------------------------------
// configHome validation (eng M-1)
// ---------------------------------------------------------------------------

describe('buildLaunchdPlist — configHome validation (eng M-1)', () => {
  it('throws ChalkBagError when configHome is a relative path', () => {
    expect(() =>
      buildLaunchdPlist({ ...defaultOptions, configHome: 'relative/config/path' }),
    ).toThrow(ChalkBagError);

    expect(() =>
      buildLaunchdPlist({ ...defaultOptions, configHome: 'relative/config/path' }),
    ).toThrow('must be an absolute path');
  });

  it('throws ChalkBagError when configHome contains a null byte (0x00)', () => {
    expect(() =>
      buildLaunchdPlist({ ...defaultOptions, configHome: '/valid/path\x00oops' }),
    ).toThrow(ChalkBagError);

    expect(() =>
      buildLaunchdPlist({ ...defaultOptions, configHome: '/valid/path\x00oops' }),
    ).toThrow('control characters');
  });

  it('throws ChalkBagError when configHome contains a tab character (0x09)', () => {
    expect(() =>
      buildLaunchdPlist({ ...defaultOptions, configHome: '/valid/path\t/oops' }),
    ).toThrow(ChalkBagError);
  });

  it('throws ChalkBagError when configHome contains a newline (0x0a)', () => {
    expect(() =>
      buildLaunchdPlist({ ...defaultOptions, configHome: '/valid/path\noops' }),
    ).toThrow(ChalkBagError);
  });

  it('accepts a normal absolute path', () => {
    expect(() =>
      buildLaunchdPlist({ ...defaultOptions, configHome: '/Users/alice/.config/chalkbag' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Snapshot assertion
// ---------------------------------------------------------------------------

describe('buildLaunchdPlist — snapshot', () => {
  it('matches expected plist structure', () => {
    const plist = buildLaunchdPlist({
      nodePath: '/usr/local/bin/node',
      tsxPath: '/usr/local/bin/tsx',
      entryPath: '/usr/local/lib/chalkbag/dist/daemon/entry.js',
      configHome: '/Users/alice/.config/chalkbag',
    });

    expect(plist).toMatchInlineSnapshot(`
"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.chalkbag.daemon</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/node</string>
      <string>/usr/local/bin/tsx</string>
      <string>/usr/local/lib/chalkbag/dist/daemon/entry.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CHALKBAG_CONFIG_HOME</key>
      <string>/Users/alice/.config/chalkbag</string>
    </dict>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>/Users/alice/.config/chalkbag/logs/chalkbag.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/alice/.config/chalkbag/logs/chalkbag.log</string>
  </dict>
</plist>
"
`);
  });
});
