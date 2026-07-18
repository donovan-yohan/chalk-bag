/**
 * Marker-delimited "managed block" editing for config files chalkbag does not
 * own outright (today: the user's real `~/.codex/config.toml`).
 *
 * chalkbag owns only the lines between its markers and preserves everything
 * outside byte-for-byte. This lets a live, user-authored config file receive
 * generated content without chalkbag ever rewriting the file wholesale.
 */

import { ChalkBagError } from './types.js';

export type ManagedBlockMarkers = {
  begin: string;
  end: string;
};

export const CHALKBAG_MANAGED_MARKERS: ManagedBlockMarkers = {
  begin: '# >>> chalkbag managed — do not edit inside >>>',
  end: '# <<< chalkbag managed <<<',
};

/**
 * Inserts or replaces the managed region in `existing`.
 *
 * - If both markers are present (in order), the region between them
 *   (markers inclusive) is replaced with the fresh block.
 * - If they are absent, the block is appended, separated from any prior
 *   content by exactly one blank line.
 *
 * Content outside the markers is preserved exactly. The returned string always
 * ends with a single trailing newline.
 */
export function upsertManagedBlock(
  existing: string,
  body: string,
  markers: ManagedBlockMarkers = CHALKBAG_MANAGED_MARKERS,
  filePath = 'config file',
): string {
  const block = renderBlock(body, markers);
  const region = findManagedRegion(existing, markers, filePath);

  if (region === null) {
    const trimmed = existing.replace(/\n+$/u, '');
    if (trimmed.length === 0) {
      return `${block}\n`;
    }
    return `${trimmed}\n\n${block}\n`;
  }

  const before = existing.slice(0, region.start);
  const after = existing.slice(region.end);
  // `region.end` consumed the end-marker's own newline, so reinstate exactly
  // one newline after the block — keeping insert and replace byte-identical.
  return `${before}${block}\n${after}`;
}

/**
 * Removes the managed region from `existing`, collapsing the blank-line
 * separator that {@link upsertManagedBlock} introduced. Content outside the
 * markers is preserved. Returns the input unchanged when no managed block is
 * present. An input that contained only the managed block becomes `''`.
 */
export function removeManagedBlock(
  existing: string,
  markers: ManagedBlockMarkers = CHALKBAG_MANAGED_MARKERS,
  filePath = 'config file',
): string {
  const region = findManagedRegion(existing, markers, filePath);
  if (region === null) {
    return existing;
  }

  const before = existing.slice(0, region.start).replace(/\n+$/u, '');
  const after = existing.slice(region.end).replace(/^\n+/u, '');

  if (before.length === 0 && after.length === 0) {
    return '';
  }
  if (before.length === 0) {
    return `${after}\n`.replace(/\n+$/u, '\n');
  }
  if (after.length === 0) {
    return `${before}\n`;
  }
  return `${before}\n\n${after}\n`.replace(/\n+$/u, '\n');
}

/** Returns true when a well-formed managed region exists in `existing`. */
export function hasManagedBlock(
  existing: string,
  markers: ManagedBlockMarkers = CHALKBAG_MANAGED_MARKERS,
  filePath = 'config file',
): boolean {
  return findManagedRegion(existing, markers, filePath) !== null;
}

function renderBlock(body: string, markers: ManagedBlockMarkers): string {
  const normalized = body.replace(/\r\n/gu, '\n').replace(/\n+$/u, '');
  return normalized.length === 0
    ? `${markers.begin}\n${markers.end}`
    : `${markers.begin}\n${normalized}\n${markers.end}`;
}

/**
 * Locates the character span of the managed region (from the start of the
 * begin marker line to the end of the end marker line). Returns `null` only when
 * *neither* marker is present (a clean file with no managed block).
 *
 * A file carrying exactly one marker — a begin without a matching end, or an end
 * without a begin — is a corrupt/half-written state. Treating it as "no block"
 * would append a fresh block (leaving an orphan) and a later removal could span
 * user content, so this throws a {@link ChalkBagError} instead.
 */
function findManagedRegion(
  existing: string,
  markers: ManagedBlockMarkers,
  filePath: string,
): { start: number; end: number } | null {
  const beginIndex = existing.indexOf(markers.begin);
  const endMarkerIndex =
    beginIndex === -1
      ? existing.indexOf(markers.end)
      : existing.indexOf(markers.end, beginIndex + markers.begin.length);

  if (beginIndex === -1 && endMarkerIndex === -1) {
    return null;
  }
  if (beginIndex === -1 || endMarkerIndex === -1) {
    throw new ChalkBagError({
      kind: 'config',
      file: filePath,
      message:
        'chalkbag managed-block markers are orphaned: found one marker without its matching pair',
      fix: 'repair the file manually — restore both markers in order, or remove the stray marker — then re-run',
    });
  }

  // Extend the end past the marker line's own newline so the replacement/
  // removal does not leave a dangling blank line. Tolerate a CRLF line ending
  // by consuming an optional `\r` before the `\n`.
  let end = endMarkerIndex + markers.end.length;
  if (existing[end] === '\r') {
    end += 1;
  }
  if (existing[end] === '\n') {
    end += 1;
  }
  return { start: beginIndex, end };
}
