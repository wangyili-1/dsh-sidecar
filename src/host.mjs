import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSidecarService } from './service.mjs';

export const name = 'dsh-sidecar';
export const inject = ['connection', 'sessionController'];

/** Use the installed DSH connection so every request retains its browser trust and authentication checks. */
export function apply(ctx, config = {}) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const service = createSidecarService(ctx, {
    dataDir: resolve(config.dataDir || resolve(packageRoot, '.local', 'state')),
    defaultCwd: resolve(config.defaultCwd || process.cwd()),
  });

  ctx.effect(() => () => service.dispose(), 'dsh-sidecar: service cleanup');
  ctx.connection.rpc.handle('/sidecar-api', async (endpoint, payload, signal) => {
    try {
      const value = await service.dispatch(endpoint, payload, signal);
      return { ok: true, value: value ?? null };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'sidecar/request-failed',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      };
    }
  });
}
