//! Launch flags for Android emulators: one default plus per-AVD overrides, stored
//! as a non-secret JSON value in the secure store like the other settings. The
//! flags ride after PandaCode's own every time an emulator boots.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::secret_store;

const SERVICE: &str = "app.pandacode.simulator";
const ACCOUNT: &str = "emulator-flags";
/// One flags string holds at most this many characters; anything longer is refused.
const MAX_TEXT: usize = 2000;

/// The flags the user asked for: `default` applies to every AVD, and an AVD's own
/// entry replaces it for that device.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EmulatorFlags {
    pub default: String,
    pub devices: BTreeMap<String, String>,
}

pub fn read() -> EmulatorFlags {
    secret_store::get(SERVICE, ACCOUNT).and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default()
}

pub fn write(flags: &EmulatorFlags) -> crate::Result<()> {
    let json = serde_json::to_string(flags).map_err(|e| e.to_string())?;
    secret_store::set(SERVICE, ACCOUNT, &json)
}

/// Validates and trims a saved set: blank flags are dropped so an empty device
/// entry cannot hide behind the default.
pub fn clean(default: String, devices: BTreeMap<String, String>) -> Result<EmulatorFlags, String> {
    let default = default.trim();
    if default.len() > MAX_TEXT {
        return Err("Emulator flags are too long.".into());
    }
    let mut flags = EmulatorFlags { default: default.to_string(), devices: BTreeMap::new() };
    for (avd, text) in devices {
        let text = text.trim();
        if text.len() > MAX_TEXT {
            return Err("Emulator flags are too long.".into());
        }
        if !text.is_empty() {
            flags.devices.insert(avd, text.to_string());
        }
    }
    Ok(flags)
}

/// The arguments `android::boot` starts one AVD with: PandaCode's headless
/// defaults, then the user's flags for the device. Their own `-gpu` replaces
/// PandaCode's renderer instead of riding along after it.
pub fn boot_args(name: &str) -> Vec<String> {
    let flags = read();
    launch_args(name, &for_avd(name, &flags))
}

pub fn launch_args(name: &str, extra: &[String]) -> Vec<String> {
    let mut args = ["-avd", name, "-no-window", "-no-audio", "-no-boot-anim", "-gpu", "auto"].iter().map(|flag| flag.to_string()).collect::<Vec<_>>();
    if extra.iter().any(|flag| flag == "-gpu") {
        args.truncate(args.len() - 2);
    }
    args.extend(extra.iter().cloned());
    args
}

/// The flags for one AVD: its saved entry when it has one, else the default.
pub fn for_avd(name: &str, flags: &EmulatorFlags) -> Vec<String> {
    split(flags.devices.get(name).unwrap_or(&flags.default))
}

/// Splits a flags string into arguments: whitespace separates, and `"…"` or
/// `'…'` keeps a group together, so pasted examples keep their meaning.
fn split(text: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for ch in text.chars() {
        match quote {
            Some(mark) if ch == mark => quote = None,
            Some(_) => word.push(ch),
            None if ch == '"' || ch == '\'' => { quote = Some(ch); started = true; }
            None if ch.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            None => { word.push(ch); started = true; }
        }
    }
    if started {
        words.push(word);
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(default: &str, devices: &[(&str, &str)]) -> EmulatorFlags {
        EmulatorFlags { default: default.into(), devices: devices.iter().map(|(avd, text)| (avd.to_string(), text.to_string())).collect() }
    }

    #[test]
    fn user_flags_come_after_pandacodes_own() {
        assert_eq!(launch_args("Pixel_9", &["-no-snapshot".into()]),
            vec!["-avd", "Pixel_9", "-no-window", "-no-audio", "-no-boot-anim", "-gpu", "auto", "-no-snapshot"]);
    }

    #[test]
    fn a_chosen_renderer_replaces_the_default() {
        let args = launch_args("Pixel_9", &["-gpu".into(), "swiftshader_indirect".into()]);
        assert_eq!(args.iter().filter(|flag| **flag == "-gpu").count(), 1);
        assert!(args.ends_with(&["-gpu".to_string(), "swiftshader_indirect".to_string()]));
    }

    #[test]
    fn a_device_entry_replaces_the_default() {
        let saved = flags("-no-snapshot", &[("Pixel_9_API_35", "-dns-server 8.8.8.8")]);
        assert_eq!(for_avd("Pixel_9_API_35", &saved), vec!["-dns-server", "8.8.8.8"]);
        assert_eq!(for_avd("Other", &saved), vec!["-no-snapshot"]);
    }

    #[test]
    fn blank_and_oversized_entries_are_refused_or_dropped() {
        let cleaned = clean("  -no-snapshot  ".into(), [("Pixel_9_API_35".to_string(), "  ".to_string())].into()).unwrap();
        assert_eq!(cleaned, flags("-no-snapshot", &[]));
        assert_eq!(clean("x".repeat(MAX_TEXT + 1), [].into()).unwrap_err(), "Emulator flags are too long.");
        assert_eq!(clean("x".into(), [("Pixel_9_API_35".to_string(), "y".repeat(MAX_TEXT + 1))].into()).unwrap_err(), "Emulator flags are too long.");
    }

    #[test]
    fn flags_split_on_whitespace_but_keep_quoted_groups() {
        assert_eq!(split("  -dns-server 8.8.8.8  "), vec!["-dns-server", "8.8.8.8"]);
        assert_eq!(split("-netsim-args \"--wifi-tap tap0\""), vec!["-netsim-args", "--wifi-tap tap0"]);
        assert_eq!(split("-memory '2048"), vec!["-memory", "2048"]);
        assert_eq!(split("   "), Vec::<String>::new());
    }

    #[test]
    fn saved_flags_round_trip_through_the_secure_store() {
        let saved = flags("-no-snapshot", &[("Pixel_9_API_35", "-gpu host")]);
        write(&saved).unwrap();
        assert_eq!(read(), saved);
    }
}
