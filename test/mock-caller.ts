import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AddressPolicy } from '../src/net/ssrf.js';
import { publicAddressPolicy } from '../src/net/ssrf.js';

/**
 * A local "caller": serves source files over signed-GET-shaped URLs and
 * receives audiosonde's signed callbacks, so integration tests exercise the
 * real network path end to end on 127.0.0.1.
 */

export interface ServedSource {
  readonly data: Buffer;
  readonly delayMs?: number;
  readonly status?: number;
  readonly headers?: Record<string, string>;
}

export interface ReceivedCallback {
  readonly headers: IncomingMessage['headers'];
  readonly rawBody: string;
  readonly body: Record<string, unknown>;
}

export interface ReceivedPut {
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
}

export class MockCaller {
  readonly callbacks: ReceivedCallback[] = [];
  readonly puts: ReceivedPut[] = [];
  /** Status answered to each callback POST, by attempt index (last repeats). */
  callbackStatuses: number[] = [200];
  /** Status answered to artifact PUTs (M3+ tests). */
  putStatus = 200;

  private readonly sources = new Map<string, ServedSource>();
  private readonly redirects = new Map<string, { location: string; status: number }>();
  private server: Server | undefined;
  private port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    this.port = address.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  serve(path: string, source: ServedSource): void {
    this.sources.set(path, source);
  }

  redirect(path: string, location: string, status = 302): void {
    this.redirects.set(path, { location, status });
  }

  async waitForCallbacks(count: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.callbacks.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${count} callback(s); got ${this.callbacks.length}`);
      }
      await sleep(5);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? '/';

    const redirect = this.redirects.get(path);
    if (redirect !== undefined) {
      res.writeHead(redirect.status, { location: redirect.location });
      res.end();
      return;
    }

    if (req.method === 'GET') {
      const source = this.sources.get(path);
      if (source === undefined) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (source.delayMs !== undefined) await sleep(source.delayMs);
      res.writeHead(source.status ?? 200, {
        'content-length': String(source.data.length),
        ...source.headers,
      });
      res.end(source.data);
      return;
    }

    const body = await readBody(req);

    if (req.method === 'POST' && path === '/callback') {
      const rawBody = body.toString('utf8');
      this.callbacks.push({
        headers: req.headers,
        rawBody,
        body: JSON.parse(rawBody) as Record<string, unknown>,
      });
      const index = Math.min(this.callbacks.length - 1, this.callbackStatuses.length - 1);
      res.writeHead(this.callbackStatuses[index] ?? 200);
      res.end();
      return;
    }

    if (req.method === 'PUT') {
      this.puts.push({ path, headers: req.headers, body });
      res.writeHead(this.putStatus);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Address policy for tests ONLY: loopback is allowed (the mock caller lives
 * there); everything else still goes through the production policy, so SSRF
 * tests against e.g. 169.254.0.0/16 exercise the real rules.
 */
export const loopbackAllowedPolicy: AddressPolicy = {
  check(address: string): string | null {
    if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') {
      return null;
    }
    return publicAddressPolicy.check(address);
  },
};
