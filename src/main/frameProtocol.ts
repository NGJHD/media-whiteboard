import { protocol, net } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FRAME_SCHEME } from '../shared/ipc';
import { firstFramePath, proxyDir } from './media';

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

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/**
 * Cached entry extension per cache key.
 *
 * A cached frame is `.png` for anything decoded, or the source's own container
 * for a static image that was copied in rather than transcoded (§7). Rather than
 * carry that into the URL — and therefore into `MediaObject` and every saved
 * project — the extension is read off the published directory once and
 * remembered. Only successful resolutions are cached: an entry that is still
 * decoding has no directory yet, and must be looked at again once it does.
 */
const entryExtensions = new Map<string, string>();

async function resolveExtension(dir: string): Promise<string | null> {
  const names = await fsp.readdir(dir).catch(() => null);
  if (!names) return null;
  const first = names.find((n) => n.startsWith('000001.'));
  return first ? path.extname(first).toLowerCase() : null;
}

export function forgetFrameExtension(cacheKey: string): void {
  entryExtensions.delete(cacheKey);
}

export function serveFrames(getCacheDir: () => string): void {
  protocol.handle(FRAME_SCHEME, async (request) => {
    const url = new URL(request.url);
    // mwframe://frame/<cacheKey>/<index> — native frames, what export reads.
    // mwframe://proxy/<cacheKey>/<index> — reduced-resolution preview frames.
    const wantsProxy = url.host === 'proxy';
    const [cacheKey, rawIndex] = url.pathname.replace(/^\//, '').split('/');
    const index = Number(rawIndex);

    // The renderer is not trusted to stay inside the cache directory: a key of
    // "../.." would otherwise read anything on disk.
    if (!cacheKey || !/^[a-f0-9]{16}$/.test(cacheKey) || !Number.isInteger(index) || index < 0) {
      return new Response('bad request', { status: 400 });
    }

    const cacheDir = getCacheDir();
    const dir = wantsProxy ? proxyDir(cacheDir, cacheKey) : path.join(cacheDir, cacheKey);
    const name = String(index + 1).padStart(6, '0');

    // corsEnabled means Chromium enforces CORS on this scheme, so the response
    // has to opt in. The scheme only ever serves this app's own cache
    // directory, and the check above rejects any key that is not a 16-hex cache
    // id, so there is nothing here to protect from the page.
    const serve = async (file: string, ext: string): Promise<Response | null> => {
      const response = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
      if (!response?.ok) return null;
      return new Response(response.body, {
        status: 200,
        headers: {
          'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      });
    };

    // Proxies are always encoded, so their extension is never in question. Only
    // the native set can be a copied source in its own container.
    if (wantsProxy) {
      const hit = await serve(path.join(dir, `${name}.png`), '.png');
      if (hit) return hit;
      if (index === 0) {
        const first = firstFramePath(cacheDir, cacheKey);
        const stand = await serve(first, path.extname(first));
        if (stand) return stand;
      }
      return new Response('not found', { status: 404 });
    }

    const known = entryExtensions.get(cacheKey);
    if (known) {
      const hit = await serve(path.join(dir, `${name}${known}`), known);
      if (hit) return hit;
      entryExtensions.delete(cacheKey);
    }

    const ext = await resolveExtension(dir);
    if (ext) {
      entryExtensions.set(cacheKey, ext);
      const hit = await serve(path.join(dir, `${name}${ext}`), ext);
      if (hit) return hit;
    }

    // §7 phase one: until the background decode publishes its directory, the
    // only frame on disk is the standalone first frame. Serving it here is what
    // lets a 30 s video appear on the canvas the moment it is dropped.
    if (index === 0) {
      const first = firstFramePath(cacheDir, cacheKey);
      const hit = await serve(first, path.extname(first));
      if (hit) return hit;
    }

    // A frame that is not decoded yet is an ordinary state, not an error: the
    // preview loop asks for frames ahead of the decoder and draws nothing until
    // they land.
    return new Response('not found', { status: 404 });
  });
}
