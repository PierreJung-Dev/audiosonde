import { z } from 'zod';

/**
 * Resolved runtime configuration. The engine is stateless and fail-closed:
 * it refuses to boot without a shared HMAC secret (see {@link loadConfig}).
 */
export interface Config {
  /** Secret used to SIGN outbound callbacks (the primary/current secret). */
  readonly signingSecret: string;
  /**
   * Secrets ACCEPTED on inbound requests, primary first. Holds the previous
   * secret during a rotation window so callers can migrate without downtime.
   */
  readonly acceptedSecrets: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly maxConcurrentJobs: number;
  readonly maxSourceBytes: number;
  readonly maxDurationMs: number;
  readonly jobTimeoutMs: number;
  readonly signatureToleranceSeconds: number;
  readonly binaries: {
    readonly ffmpeg: string;
    readonly ffprobe: string;
    readonly audiowaveform: string;
  };
}

const envSchema = z.object({
  // No default: fail-closed. An empty/absent secret is a boot error.
  AUDIOSONDE_SECRET: z.string().min(1, 'AUDIOSONDE_SECRET is required'),
  // Optional second accepted secret, for zero-downtime rotation.
  AUDIOSONDE_SECRET_PREVIOUS: z.string().min(1).optional(),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(4),
  MAX_SOURCE_BYTES: z.coerce.number().int().positive().default(500 * 1024 * 1024),
  MAX_DURATION_MS: z.coerce.number().int().positive().default(4 * 60 * 60 * 1000),
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  SIGNATURE_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  AUDIOWAVEFORM_PATH: z.string().min(1).default('audiowaveform'),
});

/**
 * Parse and validate configuration from the environment.
 * @throws {Error} when required configuration is missing or invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }

  const e = parsed.data;
  const acceptedSecrets =
    e.AUDIOSONDE_SECRET_PREVIOUS !== undefined
      ? [e.AUDIOSONDE_SECRET, e.AUDIOSONDE_SECRET_PREVIOUS]
      : [e.AUDIOSONDE_SECRET];

  return {
    signingSecret: e.AUDIOSONDE_SECRET,
    acceptedSecrets,
    host: e.HOST,
    port: e.PORT,
    maxConcurrentJobs: e.MAX_CONCURRENT_JOBS,
    maxSourceBytes: e.MAX_SOURCE_BYTES,
    maxDurationMs: e.MAX_DURATION_MS,
    jobTimeoutMs: e.JOB_TIMEOUT_MS,
    signatureToleranceSeconds: e.SIGNATURE_TOLERANCE_SECONDS,
    binaries: {
      ffmpeg: e.FFMPEG_PATH,
      ffprobe: e.FFPROBE_PATH,
      audiowaveform: e.AUDIOWAVEFORM_PATH,
    },
  };
}
