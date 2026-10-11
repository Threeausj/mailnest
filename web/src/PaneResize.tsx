import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, RefCallback } from 'react';

type PaneKind = 'sidebar' | 'list';
type PaneSizes = Record<PaneKind, number>;
type PaneBounds = Record<PaneKind, { min: number; max: number }>;

const STORAGE_KEY = 'mailnest:panes:v1';
const DEFAULT_SIZES: PaneSizes = { sidebar: 176, list: 288 };
const MIN_SIZES: PaneSizes = { sidebar: 140, list: 240 };
const MAX_SIZES: PaneSizes = { sidebar: 320, list: 560 };
const READER_MIN = 320;
const DIVIDER_WIDTH = 6;
const TOUCH_DIVIDER_WIDTH = 16;
const THREE_PANE_MIN_WIDTH = 1024;
const TOUCH_QUERY = '(any-pointer: coarse)';

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readSizes(): PaneSizes {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!value || typeof value !== 'object') return { ...DEFAULT_SIZES };
    const saved = value as Partial<PaneSizes>;
    return {
      sidebar: typeof saved.sidebar === 'number' && Number.isFinite(saved.sidebar) ? clamp(saved.sidebar, MIN_SIZES.sidebar, MAX_SIZES.sidebar) : DEFAULT_SIZES.sidebar,
      list: typeof saved.list === 'number' && Number.isFinite(saved.list) ? clamp(saved.list, MIN_SIZES.list, MAX_SIZES.list) : DEFAULT_SIZES.list,
    };
  } catch {
    return { ...DEFAULT_SIZES };
  }
}

function saveSizes(sizes: PaneSizes) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes)); }
  catch { /* Resizing also works when the browser disables local storage. */ }
}

function fitSizes(preferred: PaneSizes, width: number, dividerWidth: number): { sizes: PaneSizes; bounds: PaneBounds } {
  const available = Math.max(MIN_SIZES.sidebar + MIN_SIZES.list, width - READER_MIN - dividerWidth * 2);
  const sidebarMax = Math.min(MAX_SIZES.sidebar, available - MIN_SIZES.list);
  const sidebar = clamp(preferred.sidebar, MIN_SIZES.sidebar, sidebarMax);
  const listMax = Math.min(MAX_SIZES.list, available - sidebar);
  const list = clamp(preferred.list, MIN_SIZES.list, listMax);
  return {
    sizes: { sidebar, list },
    bounds: {
      sidebar: { min: MIN_SIZES.sidebar, max: sidebarMax },
      list: { min: MIN_SIZES.list, max: listMax },
    },
  };
}

interface DragState {
  kind: PaneKind;
  pointerId: number;
  target: HTMLDivElement;
  startX: number;
  startWidth: number;
  before: PaneSizes;
}

function releaseCapture(drag: DragState | null) {
  if (!drag) return;
  try {
    if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
  } catch { /* The element or pointer may have disappeared during navigation. */ }
}

export interface PaneSizesController {
  rootRef: RefCallback<HTMLDivElement>;
  style: CSSProperties;
  isDesktop: boolean;
  isDragging: boolean;
  widths: PaneSizes;
  bounds: PaneBounds;
  activePane: PaneKind | null;
  startDrag: (kind: PaneKind, event: PointerEvent<HTMLDivElement>) => void;
  moveDrag: (event: PointerEvent<HTMLDivElement>) => void;
  endDrag: (event: PointerEvent<HTMLDivElement>) => void;
  cancelDrag: () => void;
  reset: (kind: PaneKind) => void;
  resizeByKey: (kind: PaneKind, event: KeyboardEvent<HTMLDivElement>) => void;
}

/** Preserve preferred widths while fitting the actual container after a resize. */
export function usePaneSizes(): PaneSizesController {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const rootRef = useCallback<RefCallback<HTMLDivElement>>((element) => { setRoot(element); }, []);
  const [preferred, setPreferred] = useState<PaneSizes>(readSizes);
  const preferredRef = useRef(preferred);
  const [width, setWidth] = useState(window.innerWidth);
  const [hasTouch, setHasTouch] = useState(() => window.matchMedia(TOUCH_QUERY).matches);
  const [activePane, setActivePane] = useState<PaneKind | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dividerWidth = hasTouch ? TOUCH_DIVIDER_WIDTH : DIVIDER_WIDTH;
  const fit = fitSizes(preferred, width, dividerWidth);
  // Pane visibility depends on room for reading, including on touch-only tablets.
  const isDesktop = width >= THREE_PANE_MIN_WIDTH;
  const metrics = useRef({ width, dividerWidth, isDesktop, fit });
  metrics.current = { width, dividerWidth, isDesktop, fit };

  const updatePreferred = useCallback((next: PaneSizes) => {
    preferredRef.current = next;
    setPreferred(next);
  }, []);

  const finishDrag = useCallback((commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (commit) saveSizes(preferredRef.current);
    else updatePreferred(drag.before);
    setActivePane(null);
    releaseCapture(drag);
  }, [updatePreferred]);

  useLayoutEffect(() => {
    if (!root) { finishDrag(false); return; }
    const updateWidth = () => { setWidth(root.getBoundingClientRect().width); };
    updateWidth();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateWidth) : null;
    observer?.observe(root);
    window.addEventListener('resize', updateWidth);
    return () => { observer?.disconnect(); window.removeEventListener('resize', updateWidth); };
  }, [root, finishDrag]);

  useEffect(() => {
    const media = window.matchMedia(TOUCH_QUERY);
    const update = () => { setHasTouch(media.matches); };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!isDesktop) finishDrag(false);
  }, [isDesktop, finishDrag]);

  useEffect(() => {
    if (!activePane) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); finishDrag(false); }
    };
    const onBlur = () => { finishDrag(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('blur', onBlur); };
  }, [activePane, finishDrag]);

  useEffect(() => () => {
    const drag = dragRef.current;
    dragRef.current = null;
    releaseCapture(drag);
  }, []);

  function applyWidth(kind: PaneKind, value: number, persist: boolean) {
    const current = metrics.current;
    const { min, max } = fitSizes(preferredRef.current, current.width, current.dividerWidth).bounds[kind];
    const next = { ...preferredRef.current, [kind]: Math.round(clamp(value, min, max)) };
    updatePreferred(next);
    if (persist) saveSizes(next);
  }

  function startDrag(kind: PaneKind, event: PointerEvent<HTMLDivElement>) {
    if (!metrics.current.isDesktop || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    finishDrag(false);
    const target = event.currentTarget;
    target.focus({ preventScroll: true });
    dragRef.current = {
      kind, pointerId: event.pointerId, target,
      startX: event.clientX, startWidth: metrics.current.fit.sizes[kind],
      before: { ...preferredRef.current },
    };
    setActivePane(kind);
    try { target.setPointerCapture(event.pointerId); }
    catch { finishDrag(false); }
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    applyWidth(drag.kind, drag.startWidth + event.clientX - drag.startX, false);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) finishDrag(true);
  }

  function reset(kind: PaneKind) {
    if (!metrics.current.isDesktop) return;
    finishDrag(false);
    applyWidth(kind, DEFAULT_SIZES[kind], true);
  }

  function resizeByKey(kind: PaneKind, event: KeyboardEvent<HTMLDivElement>) {
    if (!metrics.current.isDesktop || event.altKey || event.ctrlKey || event.metaKey) return;
    const { sizes, bounds } = fitSizes(preferredRef.current, metrics.current.width, metrics.current.dividerWidth);
    let next: number;
    const step = event.shiftKey ? 40 : 10;
    if (event.key === 'ArrowLeft') next = sizes[kind] - step;
    else if (event.key === 'ArrowRight') next = sizes[kind] + step;
    else if (event.key === 'Home') next = bounds[kind].min;
    else if (event.key === 'End') next = bounds[kind].max;
    else return;
    event.preventDefault();
    applyWidth(kind, next, true);
  }

  return {
    rootRef, style: { '--sidebar-width': `${fit.sizes.sidebar}px`, '--message-list-width': `${fit.sizes.list}px`, '--pane-divider-width': `${dividerWidth}px` } as CSSProperties,
    isDesktop, isDragging: activePane !== null, widths: fit.sizes, bounds: fit.bounds, activePane,
    startDrag, moveDrag, endDrag, cancelDrag: () => finishDrag(false), reset, resizeByKey,
  };
}

export function PaneDivider({ controller, kind }: { controller: PaneSizesController; kind: PaneKind }) {
  const bounds = controller.bounds[kind];
  return <div
    className={`pane-divider ${controller.activePane === kind ? 'is-dragging' : ''}`}
    data-pane={kind}
    role="separator"
    aria-label={kind === 'sidebar' ? '调整邮箱导航宽度' : '调整邮件列表宽度'}
    aria-orientation="vertical"
    aria-controls={kind === 'sidebar' ? 'mail-sidebar' : 'mail-message-list'}
    aria-valuemin={Math.round(bounds.min)}
    aria-valuemax={Math.round(bounds.max)}
    aria-valuenow={Math.round(controller.widths[kind])}
    aria-valuetext={`${Math.round(controller.widths[kind])} 像素`}
    aria-hidden={!controller.isDesktop || undefined}
    tabIndex={controller.isDesktop ? 0 : -1}
    title="拖动调整宽度，双击恢复默认；方向键也可调整"
    onPointerDown={(event) => controller.startDrag(kind, event)}
    onPointerMove={controller.moveDrag}
    onPointerUp={controller.endDrag}
    onPointerCancel={controller.cancelDrag}
    onLostPointerCapture={controller.cancelDrag}
    onDoubleClick={() => controller.reset(kind)}
    onKeyDown={(event) => controller.resizeByKey(kind, event)}
  />;
}

/** Stop an opaque mail iframe from consuming pointer events during a drag. */
export function PaneDragShield({ controller }: { controller: PaneSizesController }) {
  return controller.isDragging ? <div className="pane-drag-shield" aria-hidden="true" /> : null;
}
