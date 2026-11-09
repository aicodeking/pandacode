use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_PREFERENCES_BYTES: usize = 128 * 1024;
pub const ALLOWED_KEYS: &[&str] = &[
    "pandacode.theme",
    "pandacode.palette",
    "pandacode.uiScale",
    "pandacode.wallpaperPreferences",
    "pandacode.wallpapers",
    "pandacode.compact",
];

pub type PreferenceMap = BTreeMap<String, Option<String>>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub preferences: PreferenceMap,
    pub version: String,
    pub platform: String,
    pub utc_offset_minutes: i32,
    pub wallpaper_accent_seed: Option<String>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            preferences: PreferenceMap::new(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            platform: std::env::consts::OS.to_owned(),
            utc_offset_minutes: current_utc_offset_minutes(),
            wallpaper_accent_seed: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub preferences: PreferenceMap,
}

pub fn sanitize(preferences: PreferenceMap) -> Result<PreferenceMap, &'static str> {
    if preferences
        .keys()
        .any(|key| !ALLOWED_KEYS.contains(&key.as_str()))
    {
        return Err("unsupported preference key");
    }
    let encoded = serde_json::to_vec(&preferences).map_err(|_| "invalid preferences")?;
    if encoded.len() > MAX_PREFERENCES_BYTES {
        return Err("preferences exceed limit");
    }
    Ok(preferences)
}

pub fn publish(
    snapshot: &mut Snapshot,
    preferences: PreferenceMap,
    wallpaper_accent_seed: Option<String>,
) -> Result<Snapshot, &'static str> {
    publish_with_metadata(
        snapshot,
        preferences,
        current_utc_offset_minutes(),
        wallpaper_accent_seed,
    )
}

fn publish_with_metadata(
    snapshot: &mut Snapshot,
    preferences: PreferenceMap,
    utc_offset_minutes: i32,
    wallpaper_accent_seed: Option<String>,
) -> Result<Snapshot, &'static str> {
    let preferences = sanitize(preferences)?;
    let utc_offset_minutes = bounded_utc_offset_minutes(utc_offset_minutes);
    let wallpaper_accent_seed = validate_accent_seed(wallpaper_accent_seed)?;
    if snapshot.preferences != preferences
        || snapshot.utc_offset_minutes != utc_offset_minutes
        || snapshot.wallpaper_accent_seed != wallpaper_accent_seed
    {
        snapshot.preferences = preferences;
        snapshot.utc_offset_minutes = utc_offset_minutes;
        snapshot.wallpaper_accent_seed = wallpaper_accent_seed;
        snapshot.revision = snapshot.revision.saturating_add(1);
    }
    Ok(snapshot.clone())
}

fn validate_accent_seed(seed: Option<String>) -> Result<Option<String>, &'static str> {
    seed.map(|seed| {
        if seed.len() == 7
            && seed.starts_with('#')
            && seed.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        {
            Ok(seed.to_ascii_lowercase())
        } else {
            Err("wallpaper accent seed must be a six-digit hex color")
        }
    })
    .transpose()
}

fn current_utc_offset_minutes() -> i32 {
    bounded_utc_offset_minutes(chrono::Local::now().offset().local_minus_utc() / 60)
}

fn bounded_utc_offset_minutes(offset: i32) -> i32 {
    offset.clamp(-14 * 60, 14 * 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_and_oversized_preferences_fail_closed() {
        assert!(sanitize(BTreeMap::from([("not.allowed".into(), Some("x".into()))])).is_err());
        assert!(sanitize(BTreeMap::from([(
            "pandacode.theme".into(),
            Some("x".repeat(MAX_PREFERENCES_BYTES))
        )]))
        .is_err());
    }

    #[test]
    fn host_clock_offset_is_bounded_and_changes_the_revision() {
        assert_eq!(bounded_utc_offset_minutes(-841), -840);
        assert_eq!(bounded_utc_offset_minutes(841), 840);
        let mut snapshot = Snapshot {
            utc_offset_minutes: 0,
            ..Snapshot::default()
        };
        let first = publish_with_metadata(&mut snapshot, PreferenceMap::new(), 90, None).unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(first.utc_offset_minutes, 90);
        let unchanged =
            publish_with_metadata(&mut snapshot, PreferenceMap::new(), 90, None).unwrap();
        assert_eq!(unchanged.revision, 1);
        let bounded =
            publish_with_metadata(&mut snapshot, PreferenceMap::new(), 900, None).unwrap();
        assert_eq!(bounded.revision, 2);
        assert_eq!(bounded.utc_offset_minutes, 840);
    }

    #[test]
    fn browser_updates_cannot_write_host_clock_metadata() {
        let decoded = serde_json::from_value::<Update>(serde_json::json!({
            "preferences": {},
            "utcOffsetMinutes": 0
        }));
        assert!(decoded.is_err());
    }

    #[test]
    fn wallpaper_accent_seed_is_strict_normalized_host_metadata() {
        let mut snapshot = Snapshot::default();
        let published = publish_with_metadata(
            &mut snapshot,
            PreferenceMap::new(),
            0,
            Some("#A1b2C3".into()),
        )
        .unwrap();
        assert_eq!(published.wallpaper_accent_seed.as_deref(), Some("#a1b2c3"));
        assert_eq!(published.revision, 1);
        let unchanged = publish_with_metadata(
            &mut snapshot,
            PreferenceMap::new(),
            0,
            Some("#a1b2c3".into()),
        )
        .unwrap();
        assert_eq!(unchanged.revision, 1);
        assert!(
            publish_with_metadata(&mut snapshot, PreferenceMap::new(), 0, Some("#abc".into()))
                .is_err()
        );
        let decoded = serde_json::from_value::<Update>(serde_json::json!({
            "preferences": {},
            "wallpaperAccentSeed": "#a1b2c3"
        }));
        assert!(decoded.is_err());
    }
}
