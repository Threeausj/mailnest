import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
const storageKey = 'mailnest-theme';
const normalize = (value: string | null): ThemeMode => value === 'light' || value === 'dark' ? value : 'system';
function readMode(): ThemeMode {
  try { return normalize(localStorage.getItem(storageKey)); }
  catch { return 'system'; }
}
function systemIsDark() { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
function applyTheme(mode: ThemeMode, theme: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.themeMode = mode;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151a23' : '#2563eb');
}

const ThemeContext = createContext<{ mode: ThemeMode; theme: ResolvedTheme; setMode: (mode: ThemeMode) => void } | null>(null);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, updateMode] = useState(readMode);
  const [systemDark, setSystemDark] = useState(systemIsDark);
  const theme = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  useLayoutEffect(() => { applyTheme(mode, theme); }, [mode, theme]);
  useLayoutEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystem = () => setSystemDark(query.matches);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey && event.key !== null) return;
      try { if (event.storageArea && event.storageArea !== localStorage) return; } catch { /* Storage is optional. */ }
      updateMode(normalize(event.newValue));
    };
    onSystem();
    query.addEventListener('change', onSystem);
    window.addEventListener('storage', onStorage);
    return () => { query.removeEventListener('change', onSystem); window.removeEventListener('storage', onStorage); };
  }, []);
  function setMode(next: ThemeMode) {
    updateMode(next);
    try { localStorage.setItem(storageKey, next); } catch { /* Still apply the preference for this visit. */ }
  }
  return <ThemeContext.Provider value={{ mode, theme, setMode }}>{children}</ThemeContext.Provider>;
}
export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('ThemeProvider is required');
  return value;
}
