import { useStore } from '../state/store';

/** §14: every failure is a toast plus a no-op, never a crash or silent failure. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <div className="toast-body">
            <p>{toast.message}</p>
            {/* §14: ffmpeg stderr goes in an expandable detail, not the headline. */}
            {toast.detail ? (
              <details>
                <summary>Details</summary>
                <pre>{toast.detail}</pre>
              </details>
            ) : null}
          </div>
          <button className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
