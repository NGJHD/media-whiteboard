import type { ExportPhase } from '../../shared/ipc';

const PHASE_LABEL: Record<ExportPhase, string> = {
  rendering: 'Rendering frames',
  palette: 'Generating palette',
  encoding: 'Encoding',
};

export interface ExportState {
  phase: ExportPhase;
  progress: number;
  frameCount: number;
}

/**
 * §12 step 1: disable the UI, show a determinate progress bar and a Cancel
 * button. The backdrop is what disables the UI — it swallows every pointer
 * event, so no edit can change the document mid-export.
 */
export function ExportModal({ state, onCancel }: { state: ExportState; onCancel(): void }) {
  const percent = Math.round(state.progress * 100);

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Generating</h2>
        <div className="bar">
          <span style={{ width: `${percent}%` }} />
        </div>
        <p className="sub">
          {PHASE_LABEL[state.phase]} — {percent}%
          {state.phase === 'rendering' && state.frameCount > 1
            ? ` (${Math.min(state.frameCount, Math.round(state.progress * state.frameCount))} / ${state.frameCount} frames)`
            : null}
        </p>
        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
