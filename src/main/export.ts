import { ipcMain, type MessagePortMain } from 'electron';
import fsp from 'node:fs/promises';
import { Encoder } from './encoder';
import type { EncodeRequest, ExportResult, FrameMessage, FrameReply } from '../shared/ipc';

/**
 * Main-process end of the export frame channel (CLAUDE.md §3, §12).
 *
 * The renderer sends one frame at a time and waits for the matching ack. Main
 * only acks after ffmpeg's stdin has accepted the write — awaiting 'drain' first
 * when the pipe is full — so the render loop is throttled by the encoder rather
 * than queueing frames into memory.
 */

interface StartPayload {
  id: string;
  request: EncodeRequest;
}

export function registerExportHandler(getCacheDir: () => string): void {
  ipcMain.on('export:start', (event, payload: StartPayload) => {
    const port = event.ports[0];
    if (!port) return;
    void runExport(port, payload.request, getCacheDir());
  });
}

async function runExport(
  port: MessagePortMain,
  request: EncodeRequest,
  cacheDir: string,
): Promise<void> {
  const startedAt = Date.now();
  const send = (reply: FrameReply) => {
    try {
      port.postMessage(reply);
    } catch {
      // The renderer navigated away mid-export; nothing to report to.
    }
  };

  const encoder = new Encoder(request, cacheDir, {
    onPhase: (phase, progress) => send({ type: 'progress', phase, progress }),
  });

  let finished = false;
  const finish = async (result: ExportResult) => {
    if (finished) return;
    finished = true;
    send({ type: 'done', result });
    port.close();
  };

  const fail = async (err: unknown) => {
    if (finished) return;
    finished = true;
    const message = err instanceof Error ? err.message : String(err);
    const detail =
      (err as { detail?: string }).detail ?? (err instanceof Error ? (err.stack ?? null) : null);
    await encoder.cancel().catch(() => {});
    send({ type: 'error', message, detail });
    port.close();
  };

  try {
    await encoder.start();
  } catch (err) {
    await fail(err);
    return;
  }

  // Serialize the handlers: a burst of messages must not interleave writes.
  let chain: Promise<void> = Promise.resolve();

  port.on('message', (event) => {
    const msg = event.data as FrameMessage;
    chain = chain.then(async () => {
      if (finished) return;
      try {
        switch (msg.type) {
          case 'frame': {
            await encoder.writeFrame(Buffer.from(msg.buffer));
            send({ type: 'ack', index: msg.index });
            break;
          }
          case 'finish': {
            await encoder.finish();
            const bytes = await fsp
              .stat(request.outputPath)
              .then((s) => s.size)
              .catch(() => 0);
            await finish({
              ok: true,
              outputPath: request.outputPath,
              bytes,
              elapsedMs: Date.now() - startedAt,
              cancelled: false,
              error: null,
              detail: null,
            });
            break;
          }
          case 'cancel': {
            await encoder.cancel();
            await finish({
              ok: false,
              outputPath: request.outputPath,
              bytes: 0,
              elapsedMs: Date.now() - startedAt,
              cancelled: true,
              error: null,
              detail: null,
            });
            break;
          }
        }
      } catch (err) {
        await fail(err);
      }
    });
  });

  port.start();
}
