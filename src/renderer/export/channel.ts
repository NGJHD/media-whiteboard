import type {
  EncodeRequest,
  ExportPhase,
  ExportResult,
  FrameReply,
} from '../../shared/ipc';

/**
 * Renderer end of the export frame channel (CLAUDE.md §3).
 *
 * The port arrives by `window.postMessage` from the preload rather than as a
 * return value, because contextBridge clones what it passes and a cloned port is
 * useless. See the note on `Api.startExport`.
 */

const EXPORT_PORT_MESSAGE = '__mwExportPort';

function awaitPort(id: string, timeoutMs = 5000): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Timed out waiting for the export frame port'));
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data[EXPORT_PORT_MESSAGE] !== id) return;
      const port = event.ports[0];
      if (!port) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(port);
    }

    window.addEventListener('message', onMessage);
  });
}

export interface ExportHandle {
  /**
   * Sends one RGBA frame and resolves when main has accepted it. Awaiting this is
   * what applies ffmpeg's stdin backpressure to the render loop.
   *
   * The buffer is structured-cloned, not transferred: Electron's MessagePort
   * transfer list accepts only MessagePorts, and passing an ArrayBuffer in it
   * makes the whole message deserialize to null in main. See DECISIONS.md D-010.
   * The caller keeps ownership and may reuse the buffer.
   */
  sendFrame(index: number, buffer: ArrayBuffer): Promise<void>;
  finish(): Promise<ExportResult>;
  cancel(): Promise<ExportResult>;
}

export interface ExportCallbacks {
  onProgress?(phase: ExportPhase, progress: number): void;
}

export async function openExport(
  request: EncodeRequest,
  callbacks: ExportCallbacks = {},
): Promise<ExportHandle> {
  const id = await window.api.startExport(request);
  const port = await awaitPort(id);

  const acks = new Map<number, { resolve(): void; reject(err: Error): void }>();
  let settle: ((result: ExportResult) => void) | null = null;
  let reject: ((err: Error) => void) | null = null;
  const completion = new Promise<ExportResult>((res, rej) => {
    settle = res;
    reject = rej;
  });
  // Nothing may await `completion` until finish()/cancel() is called, or an early
  // rejection would surface as an unhandled rejection.
  completion.catch(() => {});

  port.onmessage = (event: MessageEvent) => {
    const reply = event.data as FrameReply;
    switch (reply.type) {
      case 'ack':
        acks.get(reply.index)?.resolve();
        acks.delete(reply.index);
        break;
      case 'progress':
        callbacks.onProgress?.(reply.phase, reply.progress);
        break;
      case 'done':
        settle?.(reply.result);
        break;
      case 'error': {
        const err = new Error(reply.message) as Error & { detail?: string | null };
        err.detail = reply.detail;
        // Fail the frames still in flight too. Without this an encoder that dies
        // mid-export leaves the render loop awaiting an ack that will never come,
        // and the export hangs instead of reporting the failure.
        for (const pending of acks.values()) pending.reject(err);
        acks.clear();
        reject?.(err);
        break;
      }
    }
  };
  port.start();

  return {
    sendFrame(index, buffer) {
      return new Promise<void>((resolve, rejectFrame) => {
        acks.set(index, { resolve, reject: rejectFrame });
        try {
          port.postMessage({ type: 'frame', index, buffer });
        } catch (err) {
          acks.delete(index);
          rejectFrame(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    finish() {
      port.postMessage({ type: 'finish' });
      return completion;
    },
    cancel() {
      port.postMessage({ type: 'cancel' });
      return completion;
    },
  };
}
