import { describe, it, expect } from 'vitest';

import {
  CHALKBAG_MANAGED_MARKERS,
  hasManagedBlock,
  removeManagedBlock,
  upsertManagedBlock,
} from '../src/managed-block.js';
import { ChalkBagError } from '../src/types.js';

const BEGIN = CHALKBAG_MANAGED_MARKERS.begin;
const END = CHALKBAG_MANAGED_MARKERS.end;

// ---------------------------------------------------------------------------
// upsertManagedBlock — insert
// ---------------------------------------------------------------------------

describe('upsertManagedBlock — insert', () => {
  it('creates a marked block in an empty file', () => {
    const out = upsertManagedBlock('', 'sandbox_mode = "read-only"');
    expect(out).toBe(`${BEGIN}\nsandbox_mode = "read-only"\n${END}\n`);
  });

  it('appends the block after existing content, preserving it byte-for-byte', () => {
    const existing = '# my hand-written codex config\nmodel = "gpt-5"\n';
    const out = upsertManagedBlock(existing, 'approval_policy = "on-request"');
    expect(out.startsWith(existing)).toBe(true);
    expect(out).toContain(BEGIN);
    expect(out).toContain('approval_policy = "on-request"');
    // exactly one blank line between user content and the managed block
    expect(out).toBe(
      `# my hand-written codex config\nmodel = "gpt-5"\n\n${BEGIN}\napproval_policy = "on-request"\n${END}\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// upsertManagedBlock — replace
// ---------------------------------------------------------------------------

describe('upsertManagedBlock — replace', () => {
  it('replaces only the managed region and preserves content on both sides', () => {
    const existing = `top = "keep-me"

${BEGIN}
old = "stale"
${END}

bottom = "keep-me-too"
`;
    const out = upsertManagedBlock(existing, 'fresh = "new"');

    expect(out).toContain('top = "keep-me"');
    expect(out).toContain('bottom = "keep-me-too"');
    expect(out).toContain('fresh = "new"');
    expect(out).not.toContain('old = "stale"');
    // only one managed block after replace
    expect(out.split(BEGIN)).toHaveLength(2);
  });

  it('is idempotent — replacing with identical body yields identical output', () => {
    const first = upsertManagedBlock('user = "x"\n', 'a = 1\nb = 2');
    const second = upsertManagedBlock(first, 'a = 1\nb = 2');
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// removeManagedBlock
// ---------------------------------------------------------------------------

describe('removeManagedBlock', () => {
  it('removes the block and restores surrounding content', () => {
    const existing = `top = "a"

${BEGIN}
managed = true
${END}

bottom = "b"
`;
    const out = removeManagedBlock(existing);
    expect(out).toBe(`top = "a"\n\nbottom = "b"\n`);
    expect(hasManagedBlock(out)).toBe(false);
  });

  it('empties a file that contained only the managed block', () => {
    const onlyBlock = upsertManagedBlock('', 'x = 1');
    expect(removeManagedBlock(onlyBlock).trim()).toBe('');
  });

  it('returns the input unchanged when there is no managed block', () => {
    const existing = 'model = "gpt-5"\n';
    expect(removeManagedBlock(existing)).toBe(existing);
  });

  it('preserves leading content when the block is at the end', () => {
    const existing = upsertManagedBlock('keep = "yes"\n', 'y = 2');
    expect(removeManagedBlock(existing)).toBe('keep = "yes"\n');
  });
});

// ---------------------------------------------------------------------------
// CRLF tolerance
// ---------------------------------------------------------------------------

describe('managed block — CRLF tolerance', () => {
  it('replaces a block in a CRLF file without leaving a stray \\r or blank line', () => {
    const existing =
      `top = "a"\r\n\r\n${BEGIN}\r\nold = 1\r\n${END}\r\n\r\nbottom = "b"\r\n`;
    const out = upsertManagedBlock(existing, 'fresh = 2');

    // Surrounding CRLF content is preserved byte-for-byte; the end marker's
    // own \r\n is fully consumed so no stray \r or extra blank line remains.
    expect(out).toBe(
      `top = "a"\r\n\r\n${BEGIN}\nfresh = 2\n${END}\n\r\nbottom = "b"\r\n`,
    );
    expect(out.split(BEGIN)).toHaveLength(2);
    expect(out).not.toContain('old = 1');
    // no orphaned \r immediately after the end marker
    expect(out).not.toContain(`${END}\r`);
  });

  it('detects a managed block in a CRLF file', () => {
    const existing = `${BEGIN}\r\nx = 1\r\n${END}\r\n`;
    expect(hasManagedBlock(existing)).toBe(true);
  });

  it('removes a CRLF block and preserves surrounding CRLF content', () => {
    const existing = `top = "a"\r\n\r\n${BEGIN}\r\nmanaged = true\r\n${END}\r\n\r\nbottom = "b"\r\n`;
    const out = removeManagedBlock(existing);
    expect(hasManagedBlock(out)).toBe(false);
    expect(out).toContain('top = "a"');
    expect(out).toContain('bottom = "b"');
    expect(out).not.toContain('managed = true');
  });
});

// ---------------------------------------------------------------------------
// orphaned / mismatched markers
// ---------------------------------------------------------------------------

describe('managed block — orphaned markers', () => {
  it('throws on a begin marker without a matching end marker', () => {
    const orphaned = `model = "gpt-5"\n${BEGIN}\nhalf a block, no end\n`;
    expect(() => upsertManagedBlock(orphaned, 'x = 1')).toThrow(ChalkBagError);
    expect(() => hasManagedBlock(orphaned)).toThrow(ChalkBagError);
    expect(() => removeManagedBlock(orphaned)).toThrow(/orphaned/);
    try {
      upsertManagedBlock(orphaned, 'x = 1');
      expect.fail('expected an orphaned-marker error');
    } catch (err) {
      expect(err).toBeInstanceOf(ChalkBagError);
      const cb = err as ChalkBagError;
      expect(cb.kind).toBe('config');
      expect(cb.fix).toMatch(/repair the file manually/);
    }
  });

  it('throws on an end marker without a matching begin marker', () => {
    const orphaned = `model = "gpt-5"\n${END}\nstray end marker\n`;
    expect(() => upsertManagedBlock(orphaned, 'x = 1')).toThrow(ChalkBagError);
  });

  it('does not treat a clean file with neither marker as orphaned', () => {
    const clean = 'model = "gpt-5"\n';
    expect(hasManagedBlock(clean)).toBe(false);
    expect(removeManagedBlock(clean)).toBe(clean);
  });
});
