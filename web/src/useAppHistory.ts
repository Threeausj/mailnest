import { useLayoutEffect, useRef } from 'react';

export type AppHistoryOverlay = '' | 'navigation' | 'settings' | 'add-account' | 'edit-account' | 'compose' | 'install';
export interface AppHistoryView {
  accountId: string; folder: string; filter: string; page: number; selectedId: string;
  overlay: AppHistoryOverlay; editingAccountId: string;
  composeKind: 'new' | 'reply' | 'forward'; composeMessageId: string;
}
interface Entry {
  version: 1; owner: string; session: string; path: string; index: number;
  hasGuard: boolean; guard: boolean; view: AppHistoryView;
}
interface Options {
  owner: string; view: AppHistoryView;
  onRestore: (view: AppHistoryView) => AppHistoryView;
  onCloseOverlay: (view: AppHistoryView) => AppHistoryView | null;
  onRootBack: () => void;
}
const stateKey = 'mailnestNavigation';
const overlays: AppHistoryOverlay[] = ['', 'navigation', 'settings', 'add-account', 'edit-account', 'compose', 'install'];
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function readEntry(): Entry | null {
  const state: unknown = window.history.state;
  const entry = record(state) ? state[stateKey] : null;
  if (!record(entry) || entry.version !== 1 || typeof entry.owner !== 'string' || typeof entry.session !== 'string' || entry.path !== window.location.pathname ||
      !Number.isSafeInteger(entry.index) || (entry.index as number) < 0 || typeof entry.hasGuard !== 'boolean' || typeof entry.guard !== 'boolean' || !record(entry.view)) return null;
  const view = entry.view;
  if (!['accountId','folder','filter','selectedId','editingAccountId','composeMessageId'].every(key => typeof view[key] === 'string') ||
      !Number.isSafeInteger(view.page) || (view.page as number) < 1 || !overlays.includes(view.overlay as AppHistoryOverlay) || !['new','reply','forward'].includes(view.composeKind as string)) return null;
  return entry as unknown as Entry;
}
function standalone() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
function key(view: AppHistoryView) { return JSON.stringify(view); }
export function withoutOverlay(view: AppHistoryView): AppHistoryView {
  return {...view,overlay:'',editingAccountId:'',composeKind:'new',composeMessageId:''};
}
function rootView(view: AppHistoryView): AppHistoryView { return {...withoutOverlay(view),selectedId:''}; }

/** Only navigation IDs enter history; forms, credentials and mail bodies stay in React memory. */
export function useAppHistory(options: Options) {
  const callbacks = useRef(options); callbacks.current = options;
  const current = useRef<Entry | null>(null);
  const applying = useRef('');
  const pending = useRef<{index: number; view: AppHistoryView} | null>(null);
  const repair = useRef<{index: number; view?: AppHistoryView; after?: () => void} | null>(null);
  const exitArmedUntil = useRef(0);
  const owner = options.owner;

  function write(entry: Entry, push = false) {
    const previous: unknown = window.history.state;
    const state = {...(record(previous) ? previous : {}),[stateKey]:entry};
    if (push) window.history.pushState(state,''); else window.history.replaceState(state,'');
    current.current = entry;
  }
  function replaceView(view: AppHistoryView) {
    if (current.current) write({...current.current,view});
  }
  function synchronize(view: AppHistoryView) {
    let entry = current.current;
    if (!entry || pending.current || repair.current) return;
    if (applying.current) {
      if (applying.current !== key(view)) return;
      applying.current = '';
    }
    if (key(entry.view) === key(view)) return;
    exitArmedUntil.current = 0;
    // A second root Back is allowed to leave. If the OS keeps the window open,
    // the next in-app action reuses the sentinel instead of growing a new pair.
    if (entry.guard) {
      write({...entry,guard:false,index:entry.index + 1,view:rootView(entry.view)},true);
      entry = current.current!;
    }
    const previous = entry.view;
    const closesOverlay = !!previous.overlay && !view.overlay;
    const closesReader = !!previous.selectedId && !view.selectedId;
    if (closesOverlay || (!previous.overlay && closesReader)) {
      const count = (closesOverlay ? 1 : 0) + (closesReader ? 1 : 0);
      const index = Math.max(entry.hasGuard ? 1 : 0,entry.index - count);
      if (index < entry.index) {
        pending.current = {index,view};
        window.history.go(index - entry.index);
      } else replaceView(view);
      return;
    }
    const opensReader = !previous.overlay && !previous.selectedId && !!view.selectedId;
    const opensOverlay = !previous.overlay && !!view.overlay;
    if (opensReader) write({...entry,index:entry.index + 1,view:withoutOverlay(view)},true);
    if (opensOverlay) write({...current.current!,index:current.current!.index + 1,view},true);
    else replaceView(view);
  }

  useLayoutEffect(() => {
    applying.current = ''; pending.current = null; repair.current = null; exitArmedUntil.current = 0;
    if (!owner) {
      if (current.current) {
        const previous: unknown = window.history.state;
        if (record(previous)) { const state = {...previous}; delete state[stateKey]; window.history.replaceState(state,''); }
      }
      current.current = null;
      return;
    }
    const existing = readEntry();
    if (existing?.owner === owner) {
      current.current = existing;
      const restored = callbacks.current.onRestore(existing.view);
      applying.current = key(restored);
      replaceView(restored);
    } else {
      const hasGuard = standalone();
      const entry: Entry = {version:1,owner,session:crypto.randomUUID(),path:window.location.pathname,index:0,hasGuard,guard:hasGuard,view:callbacks.current.view};
      write(entry);
      if (hasGuard) write({...entry,index:1,guard:false},true);
    }
    const onPop = () => {
      const target = readEntry(), source = current.current;
      if (!target || !source || target.owner !== owner || target.session !== source.session) return;
      if (repair.current) {
        const restoring = repair.current;
        if (target.index !== restoring.index) { window.history.go(restoring.index - target.index); return; }
        repair.current = null; current.current = target;
        if (restoring.view) replaceView(restoring.view);
        restoring.after?.();
        synchronize(callbacks.current.view);
        return;
      }
      if (pending.current) {
        const closing = pending.current;
        if (target.index !== closing.index) { window.history.go(closing.index - target.index); return; }
        pending.current = null; current.current = target; replaceView(closing.view);
        synchronize(callbacks.current.view);
        return;
      }
      if (target.index < source.index && source.view.overlay) {
        const closed = callbacks.current.onCloseOverlay(source.view);
        if (!closed || closed.overlay) {
          // Keep an unsent draft mounted when confirmation is cancelled or a
          // send is busy. Editing an account returns to Settings at this level.
          repair.current = {index:source.index,...(closed ? {view:closed} : {})};
          window.history.go(source.index - target.index);
        } else {
          const index = Math.max(source.hasGuard ? 1 : 0,source.index - 1);
          if (target.index === index) { current.current = target; replaceView(closed); }
          else { repair.current = {index,view:closed}; window.history.go(index - target.index); }
        }
        return;
      }
      if (target.guard && source.hasGuard && standalone()) {
        if (source.view.selectedId) {
          const restored = callbacks.current.onRestore(rootView(source.view));
          applying.current = key(restored); repair.current = {index:1,view:restored}; window.history.go(1 - target.index);
        } else if (Date.now() < exitArmedUntil.current) {
          current.current = target; exitArmedUntil.current = 0;
          // Browsers decide whether an installed window can actually close.
          // Do not bounce again or trap the user's second Back.
          window.history.back();
        } else {
          exitArmedUntil.current = Date.now() + 2500;
          repair.current = {index:source.index,after:() => callbacks.current.onRootBack()};
          window.history.go(source.index - target.index);
        }
        return;
      }
      current.current = target;
      const restored = callbacks.current.onRestore(target.view);
      applying.current = key(restored); replaceView(restored);
    };
    window.addEventListener('popstate',onPop);
    return () => window.removeEventListener('popstate',onPop);
  }, [owner]);

  const viewKey = key(options.view);
  useLayoutEffect(() => { if (owner) synchronize(callbacks.current.view); }, [owner,viewKey]);
}
