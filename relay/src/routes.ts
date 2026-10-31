export function isKnownRoute(path: string): boolean {
  return path === "/v1/connect" || path === "/v1/account" || path === "/v1/devices" || path === "/v1/token" || path === "/v1/push/devices" || path.startsWith("/v1/devices/");
}
