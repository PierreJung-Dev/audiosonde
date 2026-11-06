import type { Analyzer } from './types.js';

/**
 * Diagnostic analyzer: performs no analysis, returns a constant fragment.
 * Exists so the full pipeline (fetch → analyze → callback) can be exercised —
 * by integration tests and by operators smoke-testing a deployment — without
 * any external binary.
 */
export const noopAnalyzer: Analyzer = {
  name: 'noop',
  algoVersion: 1,
  run: () => Promise.resolve({ ok: true }),
};
