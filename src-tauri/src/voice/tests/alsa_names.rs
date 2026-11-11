//! Linux microphone names across the cpal 0.16 → 0.17 move: 0.16 stored a card's name ("HDA Intel
//! PCH") and opened `plughw:<index>`; 0.17's `name()` is the raw PCM id. Pure, so it runs anywhere.

use super::*;
use capture::{alsa_picker_names, alsa_resolve, parse_asound_cards, AlsaCard};

/// `/proc/asound/cards` on a laptop with an Intel HDA card, HDMI audio and a USB microphone.
const PROC_CARDS: &str = " 0 [PCH            ]: HDA-Intel - HDA Intel PCH
                      HDA Intel PCH at 0xf7f10000 irq 32
 1 [NVidia         ]: HDA-Intel - HDA NVidia
                      HDA NVidia at 0xf7080000 irq 17
 2 [Snowball       ]: USB-Audio - Blue Snowball
                      BLUE MICROPHONE Blue Snowball at usb-0000:00:14.0-2, full speed
";

fn cards() -> Vec<AlsaCard> {
    parse_asound_cards(PROC_CARDS)
}

/// Input PCMs as cpal 0.17 lists them there: ALSA hints first (card-id forms, which list as duplex
/// whatever they support), then `hw`/`plughw` by card index for devices `pcm_info` says capture.
fn listed() -> Vec<String> {
    [
        "default",
        "pipewire",
        "pulse",
        "null",
        "sysdefault:CARD=PCH",
        "front:CARD=PCH,DEV=0",
        "dsnoop:CARD=PCH,DEV=0",
        "hw:CARD=PCH,DEV=0",
        "plughw:CARD=PCH,DEV=0",
        "hw:CARD=NVidia,DEV=3",
        "plughw:CARD=NVidia,DEV=3",
        "sysdefault:CARD=Snowball",
        "hw:CARD=Snowball,DEV=0",
        "plughw:CARD=Snowball,DEV=0",
        "hw:CARD=0,DEV=0",
        "plughw:CARD=0,DEV=0",
        "hw:CARD=2,DEV=0",
        "plughw:CARD=2,DEV=0",
    ]
    .map(String::from)
    .to_vec()
}

fn options(ids: &[String]) -> Vec<Option<String>> {
    ids.iter().cloned().map(Some).collect()
}

fn resolved(saved: &str, ids: &[String], cards: &[AlsaCard]) -> Option<String> {
    alsa_resolve(saved, &options(ids), cards).map(|at| ids[at].clone())
}

#[test]
fn proc_cards_give_index_id_and_the_name_cpal_016_stored() {
    let card = |index, id: &str, name: &str| AlsaCard { index, id: id.into(), name: name.into() };
    assert_eq!(
        cards(),
        [card(0, "PCH", "HDA Intel PCH"), card(1, "NVidia", "HDA NVidia"), card(2, "Snowball", "Blue Snowball")]
    );
    assert_eq!(parse_asound_cards("--- no soundcards ---\n"), []);
    assert_eq!(parse_asound_cards("10 [Device         ]: USB-Audio - USB PnP Sound - Device\n")[0].name, "USB PnP Sound - Device");
}

#[test]
fn picker_lists_builtins_then_card_names_and_hides_unsaved_raw_ids() {
    // HDA NVidia has no capture PCM by index, so 0.16 (which opened its plughw:1 for capture) left
    // it out too.
    let expected = ["default", "pipewire", "pulse", "HDA Intel PCH", "Blue Snowball"];
    assert_eq!(alsa_picker_names(&listed(), &cards(), None), expected);
    // A saved card name or builtin adds nothing; an unlisted saved id is not invented.
    for saved in ["HDA Intel PCH", "pulse", "plughw:CARD=9,DEV=0"] {
        assert_eq!(alsa_picker_names(&listed(), &cards(), Some(saved)), expected);
    }
}

#[test]
fn picker_lists_the_raw_id_0_3_109_saved_so_it_shows_as_connected() {
    let names = alsa_picker_names(&listed(), &cards(), Some("dsnoop:CARD=PCH,DEV=0"));
    assert_eq!(names, ["default", "pipewire", "pulse", "HDA Intel PCH", "Blue Snowball", "dsnoop:CARD=PCH,DEV=0"]);
}

#[test]
fn without_procfs_the_picker_lists_every_raw_id_as_0_3_109_did() {
    let ids = listed();
    let names = alsa_picker_names(&ids, &[], None);
    assert_eq!(names[..3], ["default", "pipewire", "pulse"]);
    let raw: Vec<String> = ids.iter().filter(|id| !["default", "pipewire", "pulse"].contains(&id.as_str())).cloned().collect();
    assert_eq!(names[3..], raw[..]);
    assert_eq!(alsa_picker_names(&ids, &[], Some("hw:CARD=0,DEV=0")), names);
}

#[test]
fn a_016_card_name_opens_the_pcm_016_opened() {
    let (ids, cards) = (listed(), cards());
    assert_eq!(resolved("HDA Intel PCH", &ids, &cards).as_deref(), Some("plughw:CARD=0,DEV=0"));
    assert_eq!(resolved("Blue Snowball", &ids, &cards).as_deref(), Some("plughw:CARD=2,DEV=0"));
}

#[test]
fn ids_saved_by_0_3_109_and_builtins_resolve_exactly() {
    let (ids, cards) = (listed(), cards());
    for id in ["default", "pipewire", "pulse", "null", "dsnoop:CARD=PCH,DEV=0", "hw:CARD=Snowball,DEV=0", "plughw:CARD=0,DEV=0"] {
        assert_eq!(resolved(id, &ids, &cards).as_deref(), Some(id));
    }
    assert_eq!(resolved("A microphone that is not plugged in", &ids, &cards), None);
    // Without procfs card names are unknown, but raw ids still resolve.
    assert_eq!(resolved("hw:CARD=PCH,DEV=0", &ids, &[]).as_deref(), Some("hw:CARD=PCH,DEV=0"));
    assert_eq!(resolved("HDA Intel PCH", &ids, &[]), None);
}

#[test]
fn without_device_0_a_card_falls_back_to_its_most_compatible_capture_pcm() {
    let cards = cards();
    // Capture only on device 6 (a laptop DMIC): the indexed plughw beats the duplex hint for DEV=0.
    let dmic: Vec<String> = ["plughw:CARD=PCH,DEV=0", "hw:CARD=0,DEV=6", "plughw:CARD=0,DEV=7", "plughw:CARD=0,DEV=6"].map(String::from).to_vec();
    assert_eq!(resolved("HDA Intel PCH", &dmic, &cards).as_deref(), Some("plughw:CARD=0,DEV=6"));
    assert_eq!(resolved("HDA Intel PCH", &dmic[..2], &cards).as_deref(), Some("hw:CARD=0,DEV=6"));
    // Only card-id hints (which list as duplex even on playback-only cards): no match, so the
    // card is not listed and recording uses the default, as 0.16 did for a card it could not open.
    let hints: Vec<String> = ["hw:CARD=PCH,DEV=0", "sysdefault:CARD=PCH", "plughw:CARD=PCH,DEV=0", "front:CARD=PCH,DEV=0"].map(String::from).to_vec();
    assert_eq!(resolved("HDA Intel PCH", &hints, &cards), None);
    assert!(!alsa_picker_names(&hints, &cards, None).contains(&"HDA Intel PCH".to_owned()));
    // Another card's PCMs and malformed ids never match.
    let other: Vec<String> = ["plughw:CARD=2,DEV=0", "plughw:CARD=0", "plughw:CARD=x,DEV=0", "plughw"].map(String::from).to_vec();
    assert_eq!(resolved("HDA Intel PCH", &other, &cards), None);
}

#[test]
fn two_cards_with_one_name_resolve_to_the_lowest_index_like_016() {
    let twins = parse_asound_cards(" 3 [Snowball_1     ]: USB-Audio - Blue Snowball\n 2 [Snowball       ]: USB-Audio - Blue Snowball\n");
    let ids: Vec<String> = ["plughw:CARD=3,DEV=0", "plughw:CARD=2,DEV=0"].map(String::from).to_vec();
    assert_eq!(resolved("Blue Snowball", &ids, &twins).as_deref(), Some("plughw:CARD=2,DEV=0"));
    assert_eq!(resolved("Blue Snowball", &ids[..1], &twins).as_deref(), Some("plughw:CARD=3,DEV=0"));
    // Both cards list under one name, as in 0.16; the caller drops the duplicate.
    assert_eq!(alsa_picker_names(&ids, &twins, None)[..], ["Blue Snowball", "Blue Snowball"]);
}
