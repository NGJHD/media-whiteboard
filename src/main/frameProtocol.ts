import { protocol, net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FRAME_SCHEME } from '../shared/ipc';

/**
 * Serves decoded cache frames to the renderer over a custom scheme (§7).
 *
 * The alternative — reading each frame in main and posting the bytes — would
 * copy every frame through IPC just to hand it to `createImageBitmap`. This way
 * Chromium loads the file itself and the renderer decodes it directly.
 */

/** Must be called before `app.whenReady()`. */
export function registerFrameScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FRAME_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Without this the renderer's fetch is refused: the page origin is
        // http://localhost in dev and file:// when packaged, so every frame
        // request is cross-origin and Chromium blocks non-CORS-enabled schemes.
        corsEnabled: true,
        bypassCSP: false,
      },
    },
  ]);
}

export function serveFrames(getCacheDir: () => string): void {
  protocol.handle(FRAME_SCHEME, (request) => {
    const url = new URL(request.url);
    // mwframe://frame/<cacheKey>/<index>
    const [cacheKey, rawIndex] = url.pathname.replace(/^\//, '').split('/');
    const index = Number(rawIndex);

    // The renderer is not trusted to stay inside the cache directory: a key of
    // "../.." would otherwise read anything on disk.
    if (!cacheKey || !/^[a-f0-9]{16}$/.test(cacheKey) || !Number.isInteger(index) || index < 0) {
      return new Response('bad request', { status: 400 });
    }

    const file = path.join(getCacheDir(), cacheKey, `${String(index + 1).padStart(6, '0')}.webp`);
    return net.fetch(pathToFileURL(file).toString()).then((response) => {
      if (!response.ok) return new Response('not found', { status: 404 });
      // corsEnabled means Chromium enforces CORS on this scheme, so the
      // response has to opt in. The scheme only ever serves this app's own
      // cache directory, and the handler above rejects any key that is not a
      // 16-hex cache id, so there is nothing here to protect from the page.
      return new Response(response.body, {
        status: 200,
        headers: {
          'Content-Type': 'image/webp',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      });
    });
  });
}
