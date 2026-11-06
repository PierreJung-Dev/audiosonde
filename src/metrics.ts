import { ERROR_CODES, type ErrorCode } from './errors.js';

/**
 * Process-local counters exposed at `GET /metrics` (Prometheus text format,
 * hand-rolled — a client-library dependency is not warranted for a dozen
 * fixed series). Counters reset on restart, which is exactly what Prometheus
 * expects from a counter.
 *
 * Label values come from closed sets only (job status, the error-code
 * taxonomy, callback outcome) — never from request data, so the exposition
 * needs no escaping and its cardinality is bounded.
 */

export type JobStatus = 'done' | 'partial' | 'failed';

const JOB_STATUSES: readonly JobStatus[] = ['done', 'partial', 'failed'];

export class Metrics {
  private jobsAccepted = 0;
  private jobsRejected = 0;
  private readonly jobsCompleted: Record<JobStatus, number> = { done: 0, partial: 0, failed: 0 };
  private readonly jobErrors: Record<ErrorCode, number> = Object.fromEntries(
    ERROR_CODES.map((code) => [code, 0]),
  ) as Record<ErrorCode, number>;
  private callbacksDelivered = 0;
  private callbacksFailed = 0;
  private jobDurationSecondsSum = 0;
  private jobDurationCount = 0;

  /** A job claimed a concurrency slot (202). */
  jobAccepted(): void {
    this.jobsAccepted += 1;
  }

  /** A job was rejected over capacity (429). */
  jobRejected(): void {
    this.jobsRejected += 1;
  }

  /** A job ran to completion (whatever its status) in `totalMs`. */
  jobCompleted(status: JobStatus, totalMs: number): void {
    this.jobsCompleted[status] += 1;
    this.jobDurationSecondsSum += totalMs / 1000;
    this.jobDurationCount += 1;
  }

  /** One structured error entry landed in a callback (or CALLBACK_FAILED). */
  jobError(code: ErrorCode): void {
    this.jobErrors[code] += 1;
  }

  /** Terminal callback outcome: delivered (2xx) or dropped after retries. */
  callbackOutcome(delivered: boolean): void {
    if (delivered) this.callbacksDelivered += 1;
    else this.callbacksFailed += 1;
  }

  /** Render the Prometheus text exposition (format version 0.0.4). */
  render(jobsInFlight: number): string {
    const lines: string[] = [];
    const metric = (
      name: string,
      type: 'counter' | 'gauge' | 'summary',
      help: string,
      samples: readonly (readonly [string, number])[],
    ): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [suffix, value] of samples) lines.push(`${name}${suffix} ${value}`);
    };

    metric('audiosonde_jobs_in_flight', 'gauge', 'Jobs currently holding a concurrency slot.', [
      ['', jobsInFlight],
    ]);
    metric('audiosonde_jobs_accepted_total', 'counter', 'Jobs accepted (202).', [
      ['', this.jobsAccepted],
    ]);
    metric('audiosonde_jobs_rejected_total', 'counter', 'Jobs rejected over capacity (429).', [
      ['', this.jobsRejected],
    ]);
    metric(
      'audiosonde_jobs_completed_total',
      'counter',
      'Jobs run to completion, by callback status.',
      JOB_STATUSES.map((status) => [`{status="${status}"}`, this.jobsCompleted[status]] as const),
    );
    metric(
      'audiosonde_job_errors_total',
      'counter',
      'Structured job errors, by taxonomy code.',
      ERROR_CODES.map((code) => [`{code="${code}"}`, this.jobErrors[code]] as const),
    );
    metric(
      'audiosonde_callbacks_total',
      'counter',
      'Terminal callback outcomes (delivered = 2xx; failed = dropped after retries).',
      [
        ['{outcome="delivered"}', this.callbacksDelivered],
        ['{outcome="failed"}', this.callbacksFailed],
      ],
    );
    metric('audiosonde_job_duration_seconds', 'summary', 'Wall-clock job duration (202 to callback dispatch).', [
      ['_sum', this.jobDurationSecondsSum],
      ['_count', this.jobDurationCount],
    ]);

    return `${lines.join('\n')}\n`;
  }
}
