import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from './api';
import type { MessageSummary } from './types';

const PAGE_SIZE = 30;
type Snapshot = {
  key: string; messages: MessageSummary[]; total: number; loaded: boolean;
  loading: boolean; loadingMore: boolean; error: string; moreError: string; hasMore: boolean;
};
const empty = (key: string): Snapshot => ({ key, messages: [], total: 0, loaded: false, loading: false, loadingMore: false, error: '', moreError: '', hasMore: false });
type Manager = { active: boolean; key: string; pages: number; rangeTotal: number; rangeLength: number; loading: boolean; pendingRefresh: boolean; revision: number; controller: AbortController; refresh: () => void; loadMore: (retry?: boolean) => void };

export function useInfiniteMessages({ owner, accountId, folder, filter, search, revision, beforeUpdate }: {
  owner: string; accountId: string; folder: string; filter: string; search: string; revision: number; beforeUpdate: () => void;
}) {
  const key = JSON.stringify([owner, accountId, folder, filter, search]);
  const [snapshot, setSnapshot] = useState(() => empty(key));
  const snapshotRef = useRef(snapshot);
  const managerRef = useRef<Manager | null>(null);
  const beforeUpdateRef = useRef(beforeUpdate); beforeUpdateRef.current = beforeUpdate;
  const commit = useCallback((next: Snapshot) => {
    if (next.messages !== snapshotRef.current.messages) beforeUpdateRef.current();
    snapshotRef.current = next; setSnapshot(next);
  }, []);

  useEffect(() => {
    const manager: Manager = {
      active: true, key, pages: 1, rangeTotal: 0, rangeLength: 0, loading: false, pendingRefresh: false, revision,
      controller: new AbortController(), refresh() {}, loadMore() {},
    };
    managerRef.current = manager;
    commit(empty(key));
    if (!owner) return () => { manager.active = false; manager.controller.abort(); };

    const requestPage = async (page: number) => {
      const params = new URLSearchParams({ folder, filter, page: String(page), pageSize: String(PAGE_SIZE) });
      if (accountId) params.set('accountId', accountId);
      if (search) params.set('q', search);
      return api<{ messages: MessageSummary[]; total: number }>(`/messages?${params}`, { signal: manager.controller.signal });
    };
    const finish = () => {
      manager.loading = false;
      if (manager.active && manager.pendingRefresh) {
        manager.pendingRefresh = false;
        manager.refresh();
      }
    };
    manager.refresh = () => {
      if (!manager.active) return;
      // Sync progress can emit several events while a request is outstanding.
      // Complete and display that snapshot, then coalesce those events once.
      if (manager.loading) { manager.pendingRefresh = true; return; }
      manager.loading = true;
      const original = new Map(snapshotRef.current.messages.map(message => [message.id, message]));
      commit({ ...snapshotRef.current, loading: true, error: '' });
      void (async () => {
        try {
          const first = await requestPage(1);
          const current = snapshotRef.current;
          // New rows shift every offset. Extend the refreshed prefix so the
          // previously loaded tail and its scroll anchor stay in the list.
          const growth = current.loaded ? Math.max(0, first.total - manager.rangeTotal) : 0;
          const targetPages = Math.min(Math.max(1, Math.ceil(first.total / PAGE_SIZE)), Math.max(manager.pages, Math.ceil((manager.rangeLength + growth) / PAGE_SIZE)));
          const pages = [first];
          for (let page = 2; page <= targetPages; page += 3) {
            pages.push(...await Promise.all(Array.from({ length: Math.min(3, targetPages - page + 1) }, (_, index) => requestPage(page + index))));
          }
          if (!manager.active) return;
          const latest = new Map(snapshotRef.current.messages.map(message => [message.id, message]));
          const unique = new Map<string, MessageSummary>();
          // Mutations received after the request started outrank that older
          // response. The queued refresh will then reconcile the server state.
          for (const page of pages) for (const message of page.messages) {
            if (original.has(message.id) && !latest.has(message.id)) continue;
            const changed = latest.get(message.id);
            unique.set(message.id, changed && changed !== original.get(message.id) ? { ...message, unread: changed.unread, starred: changed.starred } : message);
          }
          const messages = [...unique.values()];
          const total = pages[0]?.total || 0;
          manager.pages = targetPages; manager.rangeTotal = total; manager.rangeLength = messages.length;
          commit({ key, messages, total, loaded: true, loading: false, loadingMore: false, error: '', moreError: '', hasMore: messages.length < total && (pages.at(-1)?.messages.length || 0) > 0 });
        } catch (error) {
          if (manager.active) commit({ ...snapshotRef.current, loading: false, error: errorText(error) });
        } finally { finish(); }
      })();
    };
    manager.loadMore = (retry = false) => {
      const current = snapshotRef.current;
      if (!manager.active || manager.loading || !current.loaded || !current.hasMore || (current.moreError && !retry)) return;
      manager.loading = true;
      commit({ ...current, loadingMore: true, moreError: '' });
      void (async () => {
        try {
          const result = await requestPage(manager.pages + 1);
          if (!manager.active) return;
          const previous = snapshotRef.current.messages;
          const unique = new Map(previous.map(message => [message.id, message]));
          const original = new Map(current.messages.map(message => [message.id, message]));
          const overlap = result.messages.some(message => unique.has(message.id));
          for (const message of result.messages) {
            if (original.has(message.id) && !unique.has(message.id)) continue;
            const changed = unique.get(message.id);
            unique.set(message.id, changed && changed !== original.get(message.id) ? { ...message, unread: changed.unread, starred: changed.starred } : message);
          }
          const messages = [...unique.values()];
          const added = messages.length > previous.length;
          if (result.messages.length) manager.pages++;
          // A shifted next page can consist entirely of already loaded rows.
          // Rebuild the whole prefix before deciding that there is no more mail.
          if (overlap || result.total !== current.total) manager.pendingRefresh = true;
          if (!overlap && result.total === manager.rangeTotal) manager.rangeLength = messages.length;
          commit({ ...snapshotRef.current, messages, total: result.total, loadingMore: false, moreError: '', hasMore: added && messages.length < result.total });
        } catch (error) {
          if (manager.active) commit({ ...snapshotRef.current, loadingMore: false, moreError: errorText(error) });
        } finally { finish(); }
      })();
    };
    manager.refresh();
    return () => { manager.active = false; manager.controller.abort(); };
    // All query inputs are represented by key. Revision refreshes the same view
    // through the separate effect, preserving loaded pages and scroll position.
  }, [key, commit]);

  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || manager.key !== key || manager.revision === revision) return;
    manager.revision = revision; manager.refresh();
  }, [key, revision]);

  const loadMore = useCallback((retry = false) => managerRef.current?.loadMore(retry), []);
  const setMessages = useCallback((update: (messages: MessageSummary[]) => MessageSummary[]) => {
    const current = snapshotRef.current;
    commit({ ...current, messages: update(current.messages) });
  }, [commit]);
  const current = snapshot.key === key ? snapshot : empty(key);
  return { ...current, setMessages, loadMore };
}
