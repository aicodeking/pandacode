/* Automatic updates from GitHub Releases. The app checks the latest release's
 * latest.json (tauri.conf.json `plugins.updater`) shortly after launch and every six
 * hours, downloads a newer version in the background, and installs it with a restart
 * once no agent is working and the window has been idle for a while, so a restart never
 * cuts a run short. Every download is verified against the public key built into the
 * app before it installs. Settings → About → Updates picks Automatic, Notify me (checks,
 * then asks with Install and restart / Later in the header) or Off (no checks of its own).
 * A Linux copy not started from an AppImage (unpacked, or a distro package) is never
 * installed over in place: it only reports the update. The request carries no personal
 * data. The browser preview never checks. */
import { call, preview } from './bridge';
import { t } from './i18n.ts';
