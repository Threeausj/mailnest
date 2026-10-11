import { useEffect } from 'react';

type BadgeNavigator = Pick<Navigator, 'setAppBadge' | 'clearAppBadge'>;
let updates = Promise.resolve();

/** OS badges are optional; denied permission or an unsupported platform is silent. */
export function updateAppBadge(unreadCount: number | null): Promise<void> {
  if (unreadCount !== null && (!Number.isSafeInteger(unreadCount) || unreadCount < 0)) return Promise.resolve();
  const count = unreadCount ?? 0;
  // Keep read/refresh/logout writes in order, including browsers whose badge
  // promises resolve asynchronously. Logout's clear must follow prior counts.
  updates = updates.then(async () => {
    try {
      const badge = navigator as Partial<BadgeNavigator>;
      if (count > 0) {
        if (typeof badge.setAppBadge === 'function') await badge.setAppBadge.call(navigator,count);
      } else if (typeof badge.clearAppBadge === 'function') await badge.clearAppBadge.call(navigator);
      else if (typeof badge.setAppBadge === 'function') await badge.setAppBadge.call(navigator,0);
    } catch { /* Badging support and notification permission vary by OS. */ }
  });
  return updates;
}

/** Pass undefined while loading, null after logout, or the total unread count. */
export function useAppBadge(unreadCount: number | null | undefined) {
  useEffect(() => { if (unreadCount !== undefined) void updateAppBadge(unreadCount); }, [unreadCount]);
}
