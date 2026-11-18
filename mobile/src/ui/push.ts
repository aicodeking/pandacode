// Push notifications, native side: permission, the raw APNs/FCM device token, registration with
// the relay, foreground presentation and tap-to-inbox. Registration is quiet about a relay that
// predates the endpoint: classifyRegister sorts 404/405
// into 'unsupported' and this module stops trying until the next launch. No task content ever
// leaves the phone: the register body is platform + token, nothing else.
//
// import/namespace misreads expo-notifications: its enum files write `* */ export var X`, which the
// plugin's export check does not see after a comment, so it skips them. tsc still checks these names.
/* eslint-disable import/namespace */
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import { useEffect } from 'react';
import { build } from '../connect/config.ts';
import { classifyRegister, REGISTER_PATH, registerBody, type PushPlatform } from '../connect/push.ts';
import * as secrets from '../connect/secrets.ts';
import { needsRegistration, type PushStatus, type Registration } from './push-state.ts';

// Foreground: show the banner (approvals want to be seen) but stay silent; the Live Activity and
// inbox carry the detail. Set once at module load, per the library's contract.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: true }),
});

const platform = (): PushPlatform => (Platform.OS === 'ios' ? 'ios' : 'android');

let unsupportedThisLaunch = false;
let lastRegistration: Registration | null = null;

/** True when the phone can hold a push token at all (Expo Go cannot; Android needs a build). */
export async function pushAvailable(): Promise<boolean> {
  try {
    await Notifications.getPermissionsAsync();
    return true;
  } catch {
    return false;
  }
}

type Permission = Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>;
const isGranted = (status: Permission) => status.granted || status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
const statusOf = (permission: Permission): PushStatus => ({ granted: isGranted(permission), canAskAgain: permission.canAskAgain, registration: lastRegistration });

export async function notificationsGranted(): Promise<boolean> {
  return isGranted(await Notifications.getPermissionsAsync());
}

/** Asks (once, from Settings only) and registers if granted. */
export async function enableNotifications(): Promise<PushStatus> {
  if (Platform.OS === 'android' && Platform.Version >= 33) {
    await Notifications.setNotificationChannelAsync('tasks', { name: 'Tasks', importance: Notifications.AndroidImportance.HIGH });
  }
  const permission = await Notifications.requestPermissionsAsync();
  if (isGranted(permission)) await registerToken();
  return statusOf(permission);
}

/** For Settings, whenever it shows: permission can change in the system's settings, and a phone allowed there still has to register. */
export async function readNotifications(): Promise<PushStatus> {
  const permission = await Notifications.getPermissionsAsync();
  if (needsRegistration(statusOf(permission))) await registerToken();
  return statusOf(permission);
}

/** Registers this phone's device token with the relay. Never throws: the outcome says what happened
 * and stays in `lastRegistration` for Settings. An unsupported relay isn't asked again this launch. */
export async function registerToken(): Promise<Registration> {
  lastRegistration = await sendToken();
  return lastRegistration;
}

async function sendToken(): Promise<Registration> {
  if (!build) return 'skipped';
  if (unsupportedThisLaunch) return 'unsupported';
  const token = await secrets.getToken();
  if (!token) return 'skipped';
  try {
    const device = await Notifications.getDevicePushTokenAsync();
    const response = await fetch(`${build.relay}${REGISTER_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(registerBody(platform(), device.data)),
    });
    const outcome = classifyRegister(response.status);
    if (outcome === 'unsupported') unsupportedThisLaunch = true;
    return outcome;
  } catch {
    // No token on this device (Expo Go, no FCM setup) or the relay unreachable: retry next launch.
    return 'error';
  }
}

/** Runs at every launch while signed in: the relay's registry is freshest when tokens re-arrive. */
export async function enrollIfGranted(): Promise<void> {
  if (await notificationsGranted()) await registerToken();
}

/** The app icon's badge, when the user allowed badges; denied or unavailable just stays quiet. */
async function setAppBadge(count: number): Promise<void> {
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (isGranted(permission) && permission.ios?.allowsBadge !== false) await Notifications.setBadgeCountAsync(count);
  } catch (error) {
    if (__DEV__) console.warn('Could not set the app badge', error);
  }
}

/** Keeps the app icon's badge on `count` while signed in (usePushNotifications clears it after). */
export function useAppBadge(count: number) {
  useEffect(() => { void setAppBadge(count); }, [count]);
}

/** A tap opens the notification's deep link (the relay's payloads carry only a URL, never text).
 * Mounted once at the root. */
export function usePushNotifications(signedIn: boolean) {
  useEffect(() => {
    if (signedIn) void enrollIfGranted();
    else void setAppBadge(0);
    const sub = Notifications.addNotificationResponseReceivedListener(response => {
      const url = (response.notification.request.content.data as { url?: string } | null)?.url;
      if (typeof url === 'string' && url.startsWith('pandacode:')) void Linking.openURL(url);
    });
    return () => sub.remove();
  }, [signedIn]);
}
