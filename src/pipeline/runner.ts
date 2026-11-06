import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { JobFailure, toErrorEntry, type JobErrorEntry } from '../errors.js';
import type { JobRequest } from '../schema/job.js';
import { ALGO_VERSIONS, analyzersFor } from '../analyzers/registry.js';
import type { Analyzer, AnalyzerContext } from '../analyzers/types.js';
import { publicAddressPolicy, type AddressPolicy } from '../net/ssrf.js';
import { probeFile, type ProbeData } from '../media/probe.js';
import { measureLoudness, type LoudnessMeasurement } from '../media/loudness.js';
import { decodePcmWindow, type PcmWindow } from '../media/pcm.js';
import { ENGINE_VERSION } from '../version.js';
import type { Metrics } from '../metrics.js';
import { dispatchCallback } from './callback.js';
import { fetchSource } from './fetch.js';

/**
 * Job runner: bounded concurrency with reject-don't-queue backpressure.
 *
 * `tryStart` either claims a slot and starts the job, or returns false — the
 * HTTP layer then answers 429. There is deliberately NO internal queue: the
 * engine is stateless and a queued-but-unstarted job would be silently lost on
 * restart anyway. Callers' queues (which own submission retry) handle waiting.
 *
 * Every job gets its own tmp dir, removed on ALL exits (success, failure,
 * timeout) before the callback is dispatched.
 */

/** Minimal structural logger (pino-compatible subset of Fastify's logger). */
export interface RunnerLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  /** Derive a logger with bound fields (pino-style) — jobId scoping. */
  child(bindings: Record<string, unknown>): RunnerLogger;
}

export interface RunnerOptions {
  readonly config: Config;
  readonly log: RunnerLogger;
  /** Counter sink for /metrics (optional; tests may omit it). */
  readonly metrics?: Metrics;
  /** Address policy for source fetch + callback (tests inject a looser one). */
  readonly policy?: AddressPolicy;
  /** Root for per-job tmp dirs (default: os.tmpdir()). */
  readonly tmpRoot?: string;
  /** Callback retry backoff base (default 1s; tests shrink it). */
  readonly callbackBaseDelayMs?: number;
}

export interface CallbackPayload {
  readonly jobId: string;
  readonly status: 'done' | 'failed' | 'partial';
  readonly engine: { version: string; algoVersions: Readonly<Record<string, number>> };
  readonly result: Record<string, unknown>;
  readonly errors: JobErrorEntry[];
  readonly timings: {
    totalMs: number;
    downloadMs: number;
    perAnalyzerMs: Record<string, number>;
  };
}

export class JobRunner {
  private readonly config: Config;
  private readonly log: RunnerLogger;
  private readonly metrics: Metrics | undefined;
  private readonly policy: AddressPolicy;
  private readonly tmpRoot: string;
  private readonly callbackBaseDelayMs: number;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: RunnerOptions) {
    this.config = options.config;
    this.log = options.log;
    this.metrics = options.metrics;
    this.policy = options.policy ?? publicAddressPolicy;
    this.tmpRoot = options.tmpRoot ?? tmpdir();
    this.callbackBaseDelayMs = options.callbackBaseDelayMs ?? 1000;
  }

  get active(): number {
    return this.inFlight.size;
  }

  /**
   * Claim a concurrency slot and start the job, or return false (→ 429).
   * The slot is held until the callback attempt finishes and tmp is cleaned.
   */
  tryStart(job: JobRequest): boolean {
    if (this.inFlight.size >= this.config.maxConcurrentJobs) {
      this.metrics?.jobRejected();
      return false;
    }
    this.metrics?.jobAccepted();
    const promise = this.run(job)
      .catch((err: unknown) => {
        // run() reports all job failures through the callback; reaching here
        // is an engine bug — log it, never throw into the void.
        this.log.error(
          { jobId: job.jobId, err: err instanceof Error ? err.message : String(err) },
          'unexpected job runner error',
        );
      })
      .finally(() => {
        this.inFlight.delete(promise);
      });
    this.inFlight.add(promise);
    return true;
  }

  /** Wait for all in-flight jobs (graceful shutdown / test teardown). */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private async run(job: JobRequest): Promise<void> {
    const started = Date.now();
    const timeoutMs = Math.min(job.limits?.timeoutMs ?? this.config.jobTimeoutMs, this.config.jobTimeoutMs);
    const signal = AbortSignal.timeout(timeoutMs);
    // Every log line of this job carries its jobId (structured, greppable).
    const log = this.log.child({ jobId: job.jobId });
    log.info({ analyses: job.analyses, timeoutMs }, 'job started');

    const errors: JobErrorEntry[] = [];
    const result: Record<string, unknown> = {};
    const perAnalyzerMs: Record<string, number> = {};
    let downloadMs = 0;

    const tmpDir = await mkdtemp(join(this.tmpRoot, 'audiosonde-'));
    try {
      const sourcePath = join(tmpDir, 'source');
      const fetched = await fetchSource(job.source.url, sourcePath, {
        contentHash: job.source.contentHash,
        maxBytes: Math.min(job.source.maxBytes ?? this.config.maxSourceBytes, this.config.maxSourceBytes),
        policy: this.policy,
        signal,
      });
      downloadMs = fetched.downloadMs;
      log.info({ bytes: fetched.bytes, container: fetched.container, downloadMs }, 'source fetched');

      let probePromise: Promise<ProbeData> | undefined;
      let loudnessPromise: Promise<LoudnessMeasurement> | undefined;
      let pcmPromise: Promise<PcmWindow> | undefined;
      const getProbe = (): Promise<ProbeData> =>
        (probePromise ??= probeFile(sourcePath, {
          ffprobePath: this.config.binaries.ffprobe,
          timeoutMs: this.config.analyzerTimeoutMs,
          signal,
        }));
      const ctx: AnalyzerContext = {
        job,
        sourcePath,
        tmpDir,
        container: fetched.container,
        config: this.config,
        signal,
        policy: this.policy,
        probe: getProbe,
        measureLoudness: () =>
          (loudnessPromise ??= measureLoudness(sourcePath, {
            ffmpegPath: this.config.binaries.ffmpeg,
            timeoutMs: this.config.analyzerTimeoutMs,
            signal,
          })),
        pcmWindow: () =>
          (pcmPromise ??= (async (): Promise<PcmWindow> => {
            const probe = await getProbe();
            const raw = probe.format.duration ?? probe.audioStream.duration;
            const parsed = raw === undefined ? NaN : Number(raw);
            return decodePcmWindow(sourcePath, {
              ffmpegPath: this.config.binaries.ffmpeg,
              durationSeconds: Number.isFinite(parsed) ? parsed : null,
              timeoutMs: this.config.analyzerTimeoutMs,
              signal,
            });
          })()),
      };

      await this.enforceDurationCap(job, ctx);

      for (const analyzer of analyzersFor(job.analyses)) {
        const t0 = Date.now();
        try {
          result[analyzer.name] = await this.runAnalyzer(analyzer, ctx, started, timeoutMs);
        } catch (err) {
          const entry = toErrorEntry(err, 'ANALYSIS_FAILED', analyzer.name);
          errors.push(entry);
          log.warn(
            { analyzer: analyzer.name, code: entry.code, retryable: entry.retryable, err: entry.message },
            'analyzer failed',
          );
        } finally {
          perAnalyzerMs[analyzer.name] = Date.now() - t0;
        }
      }
    } catch (err) {
      // Fetch-stage failure (or timeout before/while downloading).
      const entry = toErrorEntry(err, 'SOURCE_FETCH_FAILED', null);
      errors.push(entry);
      log.warn({ code: entry.code, retryable: entry.retryable, err: entry.message }, 'job failed before analysis');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }

    const status: CallbackPayload['status'] =
      errors.length === 0 ? 'done' : Object.keys(result).length > 0 ? 'partial' : 'failed';

    const payload: CallbackPayload = {
      jobId: job.jobId,
      status,
      engine: { version: ENGINE_VERSION, algoVersions: ALGO_VERSIONS },
      result,
      errors,
      timings: { totalMs: Date.now() - started, downloadMs, perAnalyzerMs },
    };

    log.info({ status, errors: errors.length, totalMs: payload.timings.totalMs }, 'job finished');
    this.metrics?.jobCompleted(status, payload.timings.totalMs);
    for (const entry of errors) this.metrics?.jobError(entry.code);

    const outcome = await dispatchCallback(job.callback.url, payload, {
      secret: this.config.signingSecret,
      policy: this.policy,
      baseDelayMs: this.callbackBaseDelayMs,
    });
    this.metrics?.callbackOutcome(outcome.delivered);
    if (outcome.delivered) {
      log.info({ attempts: outcome.attempts }, 'callback delivered');
    } else {
      // Log-only by definition: there is nowhere left to deliver this.
      this.metrics?.jobError('CALLBACK_FAILED');
      log.error(
        {
          code: 'CALLBACK_FAILED',
          jobId: job.jobId,
          attempts: outcome.attempts,
          ...(outcome.lastStatus !== undefined ? { lastStatus: outcome.lastStatus } : {}),
          ...(outcome.lastError !== undefined ? { lastError: outcome.lastError } : {}),
        },
        'callback delivery failed; job result dropped',
      );
    }
  }

  /** Analyses that decode the whole source (expensive stages). */
  private static readonly DECODING_ANALYSES = new Set(['loudness', 'transcode', 'peaks', 'bpm', 'key']);

  /**
   * Enforce the advertised max-duration limit before any expensive stage.
   * Cheap analyses (metadata, noop) skip the gate — and the probe cost.
   */
  private async enforceDurationCap(job: JobRequest, ctx: AnalyzerContext): Promise<void> {
    if (!job.analyses.some((a) => JobRunner.DECODING_ANALYSES.has(a))) return;
    const probe = await ctx.probe();
    const raw = probe.format.duration ?? probe.audioStream.duration;
    const durationMs = raw === undefined ? null : Number(raw) * 1000;
    if (durationMs !== null && Number.isFinite(durationMs) && durationMs > this.config.maxDurationMs) {
      throw new JobFailure(
        'UNSUPPORTED_FORMAT',
        `source duration ${Math.round(durationMs)}ms exceeds the ${this.config.maxDurationMs}ms limit`,
        { retryable: false },
      );
    }
  }

  private async runAnalyzer(
    analyzer: Analyzer,
    ctx: AnalyzerContext,
    jobStarted: number,
    jobTimeoutMs: number,
  ): Promise<unknown> {
    const remaining = jobStarted + jobTimeoutMs - Date.now();
    const budget = Math.min(this.config.analyzerTimeoutMs, Math.max(remaining, 0));
    if (budget <= 0) {
      throw new JobFailure('TIMEOUT', 'job deadline exceeded before analyzer could start', {
        analyzer: analyzer.name,
        retryable: true,
      });
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new JobFailure('TIMEOUT', `analyzer exceeded its ${budget}ms budget`, {
            analyzer: analyzer.name,
            retryable: true,
          }),
        );
      }, budget);
    });
    try {
      return await Promise.race([analyzer.run(ctx), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
