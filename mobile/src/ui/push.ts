// Push notifications, native side: permission, the raw APNs/FCM device token, registration with
// the relay, foreground presentation and tap-to-inbox. Registration is quiet about a relay that
// predates the endpoint: classifyRegister sorts 404/405
// into 'unsupported' and this module stops trying until the next launch. No task content ever
// leaves the phone: the register body is platform + token, nothing else.
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import { useEffect } from 'react';
import { build } from '../connect/config.ts';
import { classifyRegister, REGISTER_PATH, registerBody, type PushPlatform } from '../connect/push.ts';
import * as secrets from '../connect/secrets.ts';

// Foreground: show the banner (approvals want to be seen) but stay silent; the Live Activity and
// inbox carry the detail. Set once at module load, per the library's contract.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

const platform = (): PushPlatform => (Platform.OS === 'ios' ? 'ios' : 'android');

let unsupportedThisLaunch = false;

/** True when the phone can hold a push token at all (Expo Go cannot; Android needs a build). */
export async function pushAvailable(): Promise<boolean> {
  try {
    await Notifications.getPermissionsAsync();
    return true;
  } catch {
    return false;
  }
}

export async function notificationsGranted(): Promise<boolean> {
  const status = await Notifications.getPermissionsAsync();
  return status.granted || status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

/** Asks (once, from the Settings toggle only) and registers if granted. Returns whether push is on. */
export async function enableNotifications(): Promise<boolean> {
  if (Platform.OS === 'android' && Platform.Version >= 33) {
    await Notifications.setNotificationChannelAsync('tasks', { name: 'Tasks', importance: Notifications.AndroidImportance.HIGH });
  }
  const status = await Notifications.requestPermissionsAsync();
  if (!status.granted) return false;
  await registerToken();
  return true;
}

/** Registers this phone's device token with the relay. Best effort: unsupported relays and
 * token failures resolve silently; only a configured build with a signed-in account proceeds. */
export async function registerToken(): Promise<void> {
  if (!build || unsupportedThisLaunch) return;
  const token = await secrets.getToken();
  if (!token) return;
  try {
    const device = await Notifications.getDevicePushTokenAsync();
    const response = await fetch(`${build.relay}${REGISTER_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(registerBody(platform(), device.data)),
    });
    if (classifyRegister(response.status) === 'unsupported') unsupportedThisLaunch = true;
  } catch {
    // No token on this device (Expo Go, no FCM setup) or the relay unreachable: retry next launch.
  }
}

/** Runs at every launch while signed in: the relay's registry is freshest when tokens re-arrive. */
export async function enrollIfGranted(): Promise<void> {
  if (await notificationsGranted()) await registerToken();
}

/** A tap opens the notification's deep link (the relay's payloads carry only a URL, never text).
 * Mounted once at the root. */
export function usePushNotifications(signedIn: boolean) {
  useEffect(() => {
    if (signedIn) void enrollIfGranted();
    const sub = Notifications.addNotificationResponseReceivedListener(response => {
      const url = (response.notification.request.content.data as { url?: string } | null)?.url;
      if (typeof url === 'string' && url.startsWith('pandacode:')) void Linking.openURL(url);
    });
    return () => sub.remove();
  }, [signedIn]);
}
