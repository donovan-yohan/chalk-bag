declare module 'picomatch' {
  export type PicomatchScanResult = {
    base: string;
  };

  interface Picomatch {
    (path: string, options?: Record<string, unknown>): (candidate: string) => boolean;
    scan(input: string): PicomatchScanResult;
  }

  const picomatch: Picomatch;

  export default picomatch;
}
