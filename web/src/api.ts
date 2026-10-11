export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('无法连接服务器，请检查网络连接后重试。', 0, 'NETWORK_ERROR');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(data.error?.message || `请求失败（${response.status}）`, response.status, data.error?.code || 'REQUEST_FAILED');
  }
  return data as T;
}

export const post = <T>(path: string, data?: unknown) => api<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) });
export const patch = <T>(path: string, data: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
export const remove = <T>(path: string, data?: unknown) => api<T>(path, { method: 'DELETE', body: data === undefined ? undefined : JSON.stringify(data) });
export const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';
