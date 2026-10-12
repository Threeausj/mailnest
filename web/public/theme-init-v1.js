// Apply a saved appearance before the app renders, including the sign-in screen.
(() => {
  let mode = 'system';
  try {
    const saved = localStorage.getItem('mailnest-theme');
    if (saved === 'light' || saved === 'dark') mode = saved;
  } catch { /* Appearance works even when browser storage is unavailable. */ }
  const theme = mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
  const root = document.documentElement;
  root.dataset.themeMode = mode;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151a23' : '#2563eb');
})();
