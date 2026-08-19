/**
 * The dev server doubles as the app's backend.
 *
 * There is exactly one process that may hold the OpenRouter key (DESIGN §5), and this is it: the `/api`
 * surface runs inside the Vite dev server, so the React app posts to `/api/triage/run` and never sees a
 * credential. That also settles why a Node runtime is irreducible here — a bearer secret is sent verbatim
 * in a request header, so whichever process builds the request holds the plaintext key.
 */

import type { IncomingMessage } from 'node:http';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const API_PREFIX = '/api/';

type ApiMethod = 'GET' | 'POST';

/** The shape `src/server/handlers.ts` exports, restated because `ssrLoadModule` returns `unknown`. */
interface ApiModule {
  handle: (
    path: string,
    method: ApiMethod,
    body: unknown,
    env: Record<string, string>,
  ) => Promise<unknown>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function triageApi(env: Record<string, string>): Plugin {
  return {
    name: 'inbound-triage-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith(API_PREFIX)) return next();

        // The query string is dropped before dispatch, so a cache-busting `?t=…` on a GET cannot turn a
        // known route into a 404.
        const path = url.split('?')[0] ?? url;

        const respond = (status: number, payload: unknown): void => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          // A cached GET would show the queue as it was before the run that just finished.
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(payload));
        };

        try {
          const method = req.method === 'GET' || req.method === 'POST' ? req.method : null;
          if (method === null) {
            return respond(405, { error: `${req.method ?? 'that method'} is not supported on ${path}` });
          }

          let body: unknown = null;
          if (method === 'POST') {
            const raw = await readBody(req);
            if (raw !== '') {
              try {
                body = JSON.parse(raw);
              } catch {
                return respond(400, { error: `${path} received a body that is not valid JSON` });
              }
            }
          }

          // Loaded lazily and through Vite's own module graph, so an edit to handlers.ts or anything it
          // imports is picked up on the next request instead of needing a restart.
          const api = (await server.ssrLoadModule('/src/server/handlers.ts')) as unknown as ApiModule;
          return respond(200, await api.handle(path, method, body, env));
        } catch (err) {
          // `status` is duck-typed off the thrown value rather than read through `instanceof HttpError`:
          // handlers.ts is loaded through ssrLoadModule, so its class is not the same object identity an
          // import here would see, and every 404, 405 and 503 would silently arrive as a 500.
          const message = err instanceof Error ? err.message : String(err);
          const thrown = err as { status?: unknown };
          const status = typeof thrown.status === 'number' ? thrown.status : 500;
          server.config.logger.error(`[api] ${req.method ?? '?'} ${path} failed: ${message}`);
          return respond(status, { error: message });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  /*
   * EMPTY prefix, and this is the line that keeps the key out of the browser bundle.
   *
   * Vite only exposes `VITE_`-prefixed variables to client code, so an unprefixed OPENROUTER_API_KEY is
   * invisible to it — including to this config, unless the prefix filter is empty. Loading with '' reads
   * the whole environment into THIS Node process, where the key stays: it goes to the api plugin above
   * and never to `define`, which is the mechanism that would compile a value into the client.
   *
   * Deleting the '' therefore looks harmless and is not: the key stops arriving here, the app reports no
   * key, and the obvious fix — renaming the variable to VITE_OPENROUTER_API_KEY so Vite picks it up — is
   * precisely the one that ships the credential to anyone who opens devtools (R8, DESIGN §5).
   */
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react(), triageApi(env)],
    server: { port: 5274, strictPort: false },
    test: {
      environment: 'node',
      globals: true,
      include: ['tests/**/*.test.ts'],
    },
  };
});
