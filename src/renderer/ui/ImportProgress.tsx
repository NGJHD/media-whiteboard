import { useStore } from '../state/store';

/**
 * Non-blocking decode progress (CLAUDE.md §7).
 *
 * One bar per source still decoding. The object it belongs to is already on the
 * canvas showing its first frame and can be moved, resized and deleted while
 * this runs — nothing here gates the UI, which is the whole point of it.
 *
 * It sits inside the viewport rather than between the viewport and the bottom
 * bar, so the app stays three sections (§9) and the canvas does not resize (and
 * therefore refit) every time a file is dropped.
 */
export function ImportProgress() {
  const imports = useStore((s) => s.imports);
  if (imports.length === 0) return null;

  return (
    <div className="import-progress">
      {imports.map((job) => {
        const fraction = job.totalFrames > 0 ? job.readyFrames / job.totalFrames : 0;
        return (
          <div className="import-job" key={job.cacheKey}>
            <span className="import-name" title={job.name}>
              {job.name}
            </span>
            <div className="bar">
              <span style={{ width: `${Math.min(100, Math.round(fraction * 100))}%` }} />
            </div>
            <span className="import-count">
              {job.readyFrames}/{job.totalFrames}
            </span>
          </div>
        );
      })}
    </div>
  );
}
