import { create } from 'zustand';

/**
 * §9: a drawing tool's options "become the defaults for the next object drawn".
 *
 * Deliberately separate from the document store: these are not part of the Doc
 * (§5), are not saved in a project file (§13), and must not create undo entries.
 */

export interface ToolDefaults {
  brushColor: string;
  brushSize: number;
  eraserSize: number;

  stroke: string;
  strokeWidth: number;
  fill: string | null;

  fontFamily: string;
  fontSize: number;
  fontStyle: string;
  textColor: string;
  outline: { color: string; width: number } | null;
  shadow: { color: string; blur: number; offsetX: number; offsetY: number } | null;

  set(patch: Partial<Omit<ToolDefaults, 'set'>>): void;
}

export const useToolDefaults = create<ToolDefaults>((set) => ({
  brushColor: '#ff3b30',
  brushSize: 8,
  eraserSize: 24,

  stroke: '#ff3b30',
  strokeWidth: 3,
  fill: null,

  fontFamily: 'Segoe UI',
  fontSize: 48,
  fontStyle: 'normal',
  textColor: '#ff3b30',
  outline: null,
  shadow: null,

  set(patch) {
    set(patch);
  },
}));
