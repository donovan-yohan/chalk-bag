export type ChalkBagErrorKind = 'cli' | 'config' | 'io' | 'daemon' | 'lock' | 'provider';

export type ChalkBagErrorOptions = {
  kind: ChalkBagErrorKind;
  file: string;
  message: string;
  cause?: unknown;
  fix?: string;
  docsUrl?: string;
};

export class ChalkBagError extends Error {
  kind: ChalkBagErrorKind;
  file: string;
  fix?: string;
  docsUrl?: string;
  override cause?: unknown;

  constructor(options: ChalkBagErrorOptions) {
    super(options.message);
    this.name = 'ChalkBagError';
    this.kind = options.kind;
    this.file = options.file;
    this.fix = options.fix;
    this.docsUrl = options.docsUrl;
    this.cause = options.cause;
  }
}

export function isChalkBagError(value: unknown): value is ChalkBagError {
  return value instanceof ChalkBagError;
}

export function formatError(error: unknown): string {
  if (isChalkBagError(error)) {
    const causeMessage =
      error.cause instanceof Error ? error.cause.message : undefined;
    const fix = error.fix ?? 'check the referenced file';
    const docsUrl =
      error.docsUrl ??
      `https://github.com/donovan-yohan/chalk-bag/tree/master/chalkbag/docs/errors.md#${error.kind}`;

    const lines = [
      `error: ${error.message} (kind: ${error.kind}, at ${error.file})`,
      ...(causeMessage != null ? [`cause: ${causeMessage}`] : []),
      `fix: ${fix}`,
      `see: ${docsUrl}`,
    ];

    return lines.join('\n');
  }

  if (error instanceof Error) {
    return `chalkbag: unexpected error: ${error.message}`;
  }

  return 'chalkbag: unexpected error';
}
