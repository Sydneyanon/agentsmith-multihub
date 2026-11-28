/** Resource limits for one acquisition. Every limit has a default and a hard ceiling; a caller may only move within the ceiling. */
export type AcquisitionLimits = {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxTarEntries: number;
  /** Manifest rows: the database seal refuses more than 20,000. */
  maxManifestEntries: number;
  /** One stored file: the blob table refuses more than 1 MiB. */
  maxFileBytes: number;
  /** Stored bytes per snapshot: the database seal refuses more than 64 MiB. */
  maxStoredBytes: number;
  maxPathLength: number;
  maxPathDepth: number;
  maxWallClockMs: number;
  maxApiResponseBytes: number;
  maxRedirects: number;
};

const MiB = 1024 * 1024;

export const DEFAULT_LIMITS: Readonly<AcquisitionLimits> = Object.freeze({
  maxCompressedBytes: 128 * MiB, maxUncompressedBytes: 512 * MiB, maxTarEntries: 40_000, maxManifestEntries: 20_000,
  maxFileBytes: 256 * 1024, maxStoredBytes: 64 * MiB, maxPathLength: 1_024, maxPathDepth: 64,
  maxWallClockMs: 10 * 60_000, maxApiResponseBytes: 8 * MiB, maxRedirects: 3,
});

export const HARD_CEILINGS: Readonly<AcquisitionLimits> = Object.freeze({
  maxCompressedBytes: 512 * MiB, maxUncompressedBytes: 2_048 * MiB, maxTarEntries: 100_000, maxManifestEntries: 20_000,
  maxFileBytes: 1 * MiB, maxStoredBytes: 64 * MiB, maxPathLength: 1_024, maxPathDepth: 128,
  maxWallClockMs: 30 * 60_000, maxApiResponseBytes: 16 * MiB, maxRedirects: 3,
});

export function resolveLimits(overrides: Partial<AcquisitionLimits> = {}): AcquisitionLimits {
  const out: AcquisitionLimits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(overrides) as Array<keyof AcquisitionLimits>) {
    if (!(key in DEFAULT_LIMITS)) throw new Error(`unknown acquisition limit: ${String(key)}`);
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) throw new Error(`limit ${key} must be a positive integer`);
    if (value > HARD_CEILINGS[key]) throw new Error(`limit ${key} may not exceed ${HARD_CEILINGS[key]}`);
    out[key] = value;
  }
  return out;
}
