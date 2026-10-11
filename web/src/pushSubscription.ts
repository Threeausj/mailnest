import { post } from './api';

export function decodePushPublicKey(publicKey: string) {
  const base64 = publicKey.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), character => character.charCodeAt(0));
}

export function subscriptionMatchesPublicKey(subscription: PushSubscription, publicKey: string): boolean {
  // Older browser adapters may not expose options; native subscriptions do.
  if (!subscription.options) return true;
  const subscribedKey = subscription.options.applicationServerKey;
  if (!subscribedKey) return false;
  const expected = decodePushPublicKey(publicKey);
  const current = new Uint8Array(subscribedKey);
  return current.length === expected.length && current.every((byte, index) => byte === expected[index]);
}

export async function registerPushSubscription(subscription: PushSubscription): Promise<void> {
  const { keys } = subscription.toJSON();
  await post('/push/subscriptions', { endpoint: subscription.endpoint, keys });
}

export async function ensureExistingPushSubscription(publicKey: string): Promise<boolean> {
  if (!publicKey || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  if (!subscription || !subscriptionMatchesPublicKey(subscription, publicKey)) return false;
  await registerPushSubscription(subscription);
  return true;
}
