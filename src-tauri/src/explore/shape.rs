//! Turns results into a reply of bounded size: explicit reads are filled first, every other
//! request shares what is left, and whatever does not fit is counted and named.
use super::Category;
use serde_json::{json, Map, Value};

/// A request's fair share of the reply never falls below this while any room is left.
const MIN_BLOCK: usize = 160;
/// A file's header line and a symbol's line, beyond the text they carry.
const BLOCK_OVERHEAD: usize = 4;
/// Files that matched but did not fit are named, up to this many.
const MORE_FILES_NAMED: usize = 30;
/// At most this fraction (numerator, denominator) of a request's room is kept for those names.
const MORE_FILES_SHARE: (usize, usize) = (2, 5);
/// A line clipped to fewer characters than this says too little to show.
const MIN_CLIPPED: usize = 24;
/// Room kept for each request besides the reads: enough for its clipped name and an error.
const MIN_ITEM: usize = 128;
/// Reads leave at least the rest of the budget to the other requests.
const READ_SHARE_DIVISOR: usize = 4;
/// The most one search request may take, whatever room is left.
pub(super) const SEARCH_CAP: usize = 1_800;
/// Room kept for the counts a cut request adds (`truncated`, `omitted_*`, a file's hit count).
const CUT_FIELDS: usize = 96;
/// Characters kept before a match when a hit line must lose its start to show it.
const MATCH_LEAD: usize = 16;

#[derive(Clone)]
pub(super) struct Line {
    pub(super) text: String,
    pub(super) hit: bool,
    pub(super) number: usize,
    /// The line starts a definition: kept first when a file's hits are cut.
    pub(super) definition: bool,
    /// For a hit line: the character in `text` where its match starts, kept when it is clipped.
    pub(super) matched: Option<usize>,
}

pub(super) struct Group {
    pub(super) symbol: Option<String>,
    pub(super) lines: Vec<Line>,
}

pub(super) struct Block {
    pub(super) path: String,
    pub(super) groups: Vec<Group>,
    /// Matching lines in this file, kept or not.
    pub(super) matched: usize,
}

pub(super) enum Body {
    Nothing,
    Lines(Vec<Line>),
    Files(Vec<Block>),
}

/// For a read: enough to name the next range when the reply cuts it.
pub(super) struct ReadSpan {
    pub(super) path: String,
    pub(super) first: usize,
    pub(super) upper: Option<usize>,
}

pub(super) struct Item {
    pub(super) category: Category,
    pub(super) head: Map<String, Value>,
    pub(super) body: Body,
    /// Lines and files that matched, whether kept or not; what is not shown is reported.
    pub(super) total_lines: usize,
    pub(super) total_files: usize,
    pub(super) clipped_lines: usize,
    pub(super) read: Option<ReadSpan>,
}

impl Item {
    pub(super) fn new(category: Category, head: Map<String, Value>, body: Body) -> Self {
        let (total_lines, total_files) = match &body {
            Body::Nothing => (0, 0),
            Body::Lines(lines) => (lines.iter().filter(|line| line.hit).count(), 0),
            Body::Files(blocks) => (blocks.iter().map(|block| block.matched).sum(), blocks.len()),
        };
        Self { category, head, body, total_lines, total_files, clipped_lines: 0, read: None }
    }

    pub(super) fn error(category: Category, value: &str, error: impl Into<String>) -> Self {
        Self::new(category, head(&[(category.name(), json!(value)), ("error", json!(error.into()))]), Body::Nothing)
    }

    /// What the whole request would take if nothing were cut.
    pub(super) fn size(&self) -> usize {
        let body = match &self.body {
            Body::Nothing => 0,
            Body::Lines(lines) => lines_size(lines),
            Body::Files(blocks) => blocks.iter().map(block_size).sum(),
        };
        head_size(&self.head) + body
    }
}

pub(super) fn head(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs.iter().map(|(key, value)| ((*key).to_owned(), value.clone())).collect()
}

pub(super) fn plain_lines(texts: impl IntoIterator<Item = String>) -> Vec<Line> {
    texts.into_iter().enumerate().map(|(at, text)| Line { text, hit: true, number: at + 1, definition: false, matched: None }).collect()
}

fn head_size(head: &Map<String, Value>) -> usize {
    serde_json::to_string(head).map_or(0, |text| text.len())
}

fn json_len(text: &str) -> usize {
    serde_json::to_string(text).map_or(text.len(), |text| text.len())
}

fn lines_size(lines: &[Line]) -> usize {
    lines.iter().map(|line| json_len(&line.text) + 1).sum()
}

fn block_size(block: &Block) -> usize {
    let groups: usize = block.groups.iter().map(|group| BLOCK_OVERHEAD + group.symbol.as_deref().map_or(0, json_len) + lines_size(&group.lines)).sum();
    BLOCK_OVERHEAD + json_len(&block.path) + groups
}

/// Max-min fair shares: small requests get all they need, the rest split what is left.
pub(super) fn fair_caps(sizes: &[usize], budget: usize) -> Vec<usize> {
    let mut order: Vec<usize> = (0..sizes.len()).collect();
    order.sort_unstable_by_key(|&at| sizes[at]);
    let mut caps = vec![0; sizes.len()];
    let mut left = budget;
    for (done, &at) in order.iter().enumerate() {
        caps[at] = sizes[at].min(left / (sizes.len() - done));
        left -= caps[at];
    }
    caps
}

#[derive(Default)]
struct Taken {
    text: String,
    used: usize,
    shown_hits: usize,
    shown_lines: usize,
    clipped: usize,
}

/// How many characters of `text`, clipped and with its newline, take at most `room` bytes of JSON.
fn chars_within(text: &str, room: usize) -> usize {
    // The quotes, the `…` and the escaped newline.
    let mut used = json_len("…\n");
    text.chars().take_while(|ch| {
        used += json_len(ch.encode_utf8(&mut [0; 4])) - 2;
        used <= room
    }).count()
}

/// The longest part of `line` that, clipped and with its newline, takes at most `room` bytes
/// of JSON; `None` when it would keep fewer than `MIN_CLIPPED` characters. A hit line whose
/// match would be cut loses its start instead (after its `N:`), so the match shows.
fn clip_to(line: &Line, room: usize) -> Option<String> {
    let mut text = line.text.clone();
    if let Some(at) = line.matched.filter(|&at| at + MATCH_LEAD > chars_within(&line.text, room)) {
        // The number and `:` are ASCII, so its byte length is its length in characters.
        let prefix = line.text.find(':').map_or(0, |colon| colon + 1);
        let from = at.saturating_sub(MATCH_LEAD).max(prefix);
        if from > prefix {
            text = format!("{}…{}", &line.text[..prefix], line.text.chars().skip(from).collect::<String>());
        }
    }
    let chars = chars_within(&text, room);
    (chars >= MIN_CLIPPED).then(|| super::grep::clip(&text, chars) + "\n")
}

/// Lines up to `room` bytes; a first line too long for it is clipped rather than dropped.
fn take_lines(lines: &[Line], room: usize) -> Taken {
    let mut taken = Taken::default();
    for line in lines {
        let size = json_len(&line.text) + 1;
        if taken.used + size > room {
            if let Some(text) = clip_to(line, room).filter(|_| taken.shown_lines == 0) {
                taken.used = json_len(&text);
                taken = Taken { text, shown_hits: usize::from(line.hit), shown_lines: 1, clipped: 1, ..taken };
            }
            break;
        }
        taken.text.push_str(&line.text);
        taken.text.push('\n');
        taken.used += size;
        taken.shown_hits += usize::from(line.hit);
        taken.shown_lines += 1;
    }
    taken
}

/// What rendering part of a request came to.
#[derive(Default)]
struct Rendered {
    used: usize,
    shown_lines: usize,
    shown_files: usize,
    clipped: usize,
}

/// A group's lines in `room`: all of them when they fit, else its hit lines alone, so a cut
/// group never shows context without the hit it surrounds. Nothing when no hit fits.
fn take_group(lines: &[Line], room: usize) -> Taken {
    let mut taken = take_lines(lines, room);
    if taken.shown_lines < lines.len() {
        let hits: Vec<Line> = lines.iter().filter(|line| line.hit).cloned().collect();
        taken = take_lines(&hits, room);
    }
    if taken.shown_hits == 0 { Taken::default() } else { taken }
}

/// One file as lines of text: its path (with its hit count when not all are shown), then each
/// enclosing symbol as `@ kind name start-end` above the lines inside it. Groups holding a
/// definition take their room first; the rest follow in order; all are shown in line order.
/// None when not even one hit fits: a bare path is said better in `more_files`.
fn render_block(block: &Block, cap: usize) -> Option<(String, Rendered)> {
    let mut done = Rendered { used: BLOCK_OVERHEAD + json_len(&block.path), shown_files: 1, ..Rendered::default() };
    let mut order: Vec<usize> = (0..block.groups.len()).collect();
    order.sort_by_key(|&at| !block.groups[at].lines.iter().any(|line| line.hit && line.definition));
    let mut taken: Vec<Option<Taken>> = block.groups.iter().map(|_| None).collect();
    for at in order {
        let group = &block.groups[at];
        let label = group.symbol.as_deref().map_or(0, |symbol| BLOCK_OVERHEAD + json_len(symbol));
        let lines = take_group(&group.lines, cap.saturating_sub(done.used + label));
        if lines.shown_lines == 0 {
            continue;
        }
        done.used += label + lines.used;
        done.shown_lines += lines.shown_hits;
        done.clipped += lines.clipped;
        taken[at] = Some(lines);
    }
    let mut body = String::new();
    for (group, lines) in block.groups.iter().zip(taken) {
        let Some(lines) = lines else { continue };
        match &group.symbol {
            Some(symbol) => {
                body.push_str("@ ");
                body.push_str(symbol);
                body.push('\n');
            }
            // Back outside any definition after one: say so, or the lines would read as inside it.
            None if !body.is_empty() => body.push_str("@ -\n"),
            None => {}
        }
        body.push_str(&lines.text);
    }
    if body.is_empty() {
        return None;
    }
    let header = if block.matched > done.shown_lines { format!("{} ({} hits)\n", block.path, block.matched) } else { format!("{}\n", block.path) };
    Some((header + &body, done))
}

/// Fills `out` with the files that fit as one text, and names the rest.
fn render_files(blocks: &[Block], cap: usize, out: &mut Map<String, Value>) -> Rendered {
    let sizes: Vec<usize> = blocks.iter().map(block_size).collect();
    // When not every file fits, room is kept to name the rest: in the benchmark a named file was
    // as good as a shown one for finding gold, at a tenth of the bytes.
    let names: usize = blocks.iter().map(|block| json_len(&block.path) + 8).sum();
    let reserve = if sizes.iter().sum::<usize>() > cap { names.min(cap * MORE_FILES_SHARE.0 / MORE_FILES_SHARE.1) } else { 0 };
    let shares = fair_caps(&sizes, cap - reserve);
    let mut left = cap - reserve;
    let mut total = Rendered::default();
    let (mut text, mut more) = (String::new(), Vec::new());
    for ((block, share), size) in blocks.iter().zip(shares).zip(&sizes) {
        let shown = (!block.groups.is_empty() && left >= MIN_BLOCK.min(*size)).then(|| render_block(block, share.max(MIN_BLOCK.min(left)))).flatten();
        let Some((rendered, done)) = shown else {
            more.push(format!("{} ({})", block.path, block.matched));
            continue;
        };
        left = left.saturating_sub(done.used);
        total.shown_lines += done.shown_lines;
        total.shown_files += done.shown_files;
        total.clipped += done.clipped;
        text.push_str(&rendered);
    }
    if !text.is_empty() {
        out.insert("text".into(), json!(text));
    }
    left += reserve;
    if !more.is_empty() {
        let list = name_more(&more, left);
        left = left.saturating_sub(json_len(&list));
        out.insert("more_files".into(), json!(list));
    }
    total.used = cap - left;
    total
}

/// The files that did not fit, as many as `room` holds, then how many more.
fn name_more(more: &[String], room: usize) -> String {
    let mut list = String::new();
    let mut named = 0;
    for (at, name) in more.iter().take(MORE_FILES_NAMED).enumerate() {
        // Room for `, and N more` unless this is the last name.
        let tail = if at + 1 == more.len() { 0 } else { 24 };
        // A name inside the list costs its JSON length less the quotes around it.
        if json_len(&list) + 2 * usize::from(named > 0) + json_len(name) - 2 + tail > room {
            break;
        }
        if named > 0 {
            list.push_str(", ");
        }
        list.push_str(name);
        named += 1;
    }
    match (named, more.len() - named) {
        (_, 0) => list,
        (0, 1) => "1 file".into(),
        (0, rest) => format!("{rest} files"),
        (_, rest) => format!("{list}, and {rest} more"),
    }
}

fn render_body(body: &Body, cap: usize, head: &mut Map<String, Value>) -> Rendered {
    match body {
        Body::Nothing => Rendered::default(),
        Body::Lines(lines) => {
            let taken = take_lines(lines, cap);
            if taken.shown_lines > 0 {
                head.insert("text".into(), json!(taken.text));
            }
            Rendered { used: taken.used, shown_lines: taken.shown_hits, shown_files: 0, clipped: taken.clipped }
        }
        Body::Files(blocks) => render_files(blocks, cap, head),
    }
}

/// Room for the `"text":` and `"more_files":` keys and the slack in a block's estimate.
const BODY_KEYS: usize = 32;
/// How far `shrink` clips strings (in characters) and lists, one step at a time.
const SHRINK_STEPS: &[(usize, usize)] = &[(120, 20), (48, 5), (16, 2), (8, 1)];

fn map_size(map: &Map<String, Value>) -> usize {
    serde_json::to_string(map).map_or(usize::MAX, |text| text.len())
}

fn clip_value(value: &mut Value, chars: usize, items: usize) {
    match value {
        Value::String(text) if text.chars().nth(chars).is_some() => *text = super::grep::clip(text, chars),
        Value::Array(list) => {
            list.truncate(items);
            list.iter_mut().for_each(|value| clip_value(value, chars, items));
        }
        Value::Object(map) => map.values_mut().for_each(|value| clip_value(value, chars, items)),
        _ => {}
    }
}

/// How far `shrink` clips an error once nothing else is left to give up: its first words.
const ERROR_STEPS: &[usize] = &[48, 16];
/// Said by a read the reply cut, so the agent reads on before it edits.
const READ_ON: &str = "Cut: read next before editing.";

/// Makes `map` fit `cap` bytes: echoed names, paths and lists are clipped step by step, then
/// only `keep`, `error` and the counts are left, with the error clipped to its first words.
/// True when anything was cut.
pub(super) fn shrink(map: &mut Map<String, Value>, cap: usize, keep: &str) -> bool {
    if map_size(map) <= cap {
        return false;
    }
    for &(chars, items) in SHRINK_STEPS {
        // The error says what went wrong: it goes last.
        map.iter_mut().filter(|(key, _)| *key != "error").for_each(|(_, value)| clip_value(value, chars, items));
        if map_size(map) <= cap {
            return true;
        }
    }
    map.retain(|key, value| key == keep || key == "error" || value.is_number() || value.is_boolean());
    for &chars in ERROR_STEPS {
        if map_size(map) <= cap {
            return true;
        }
        map.iter_mut().for_each(|(key, value)| clip_value(value, if key == "error" { chars } else { 0 }, 0));
    }
    if map_size(map) > cap {
        map.retain(|key, _| key == keep || key == "error");
        map.insert("truncated".into(), json!(true));
    }
    true
}

/// The request as JSON in at most `cap` bytes, whether it was cut (more room would show more),
/// and whether anything was left out: a clipped line alone leaves nothing out, as
/// `clipped_lines` says.
fn render(item: &Item, cap: usize) -> (Value, bool, bool) {
    let Item { head, body, total_lines, total_files, clipped_lines, read, category } = item;
    let (total_lines, total_files, clipped_lines) = (*total_lines, *total_files, *clipped_lines);
    let mut room = cap.saturating_sub(head_size(head) + CUT_FIELDS + BODY_KEYS);
    loop {
        let mut out = head.clone();
        let done = render_body(body, room, &mut out);
        let omitted_lines = total_lines.saturating_sub(done.shown_lines);
        let omitted_files = total_files.saturating_sub(done.shown_files);
        let clipped_lines = clipped_lines + done.clipped;
        let cut = omitted_lines > 0 || omitted_files > 0 || clipped_lines > 0;
        if cut {
            out.insert("truncated".into(), json!(true));
        }
        for (key, count) in [("omitted_lines", omitted_lines), ("omitted_files", omitted_files), ("clipped_lines", clipped_lines)] {
            if count > 0 {
                out.insert(key.into(), json!(count));
            }
        }
        if let (true, Some(read)) = (omitted_lines > 0, read) {
            let upper = read.upper.map_or(String::new(), |upper| upper.to_string());
            out.insert("next".into(), json!(format!("{}:{}-{upper}", read.path, read.first + done.shown_lines)));
            out.insert("note".into(), json!(READ_ON));
        }
        let size = map_size(&out);
        if size <= cap {
            return (Value::Object(out), cut, omitted_lines > 0 || omitted_files > 0);
        }
        if room == 0 {
            // Nothing of the body is left to give up: the fields themselves go.
            out.remove("next");
            out.remove("note");
            shrink(&mut out, cap, category.name());
            return (Value::Object(out), true, true);
        }
        // A block's size is an estimate: try again with what it overshot taken off.
        room = room.saturating_sub((size - cap).max(32));
    }
}

/// A request with its place in the call.
type Numbered = (usize, Item);

/// The most a request may take: a search past its cap names its other files instead, as broad
/// searches were most of the bytes.
fn ceiling(item: &Item, room: usize) -> usize {
    if item.category == Category::Search { room.min(SEARCH_CAP) } else { room }
}

fn json_size(value: &Value) -> usize {
    serde_json::to_string(value).map_or(usize::MAX, |text| text.len())
}

/// Renders requests into `room`: each first gets its max-min fair share, then what the others
/// left goes to the cut ones in the order asked, so a share just too small for its first file
/// is not wasted while later requests take the rest. Returns the bytes used and whether any left
/// something out.
fn place_fairly(items: Vec<Numbered>, room: usize, placed: &mut [Option<(Category, Value)>]) -> (usize, bool) {
    let sizes: Vec<usize> = items.iter().map(|(_, item)| ceiling(item, item.size())).collect();
    let mut rendered: Vec<(Value, bool, bool)> = items.iter().zip(fair_caps(&sizes, room)).map(|((_, item), cap)| render(item, cap)).collect();
    let mut left = room.saturating_sub(rendered.iter().map(|(value, _, _)| json_size(value)).sum());
    for ((_, item), slot) in items.iter().zip(&mut rendered) {
        let used = json_size(&slot.0);
        if left == 0 || !slot.1 || ceiling(item, used + left) <= used {
            continue;
        }
        let again = render(item, ceiling(item, used + left));
        left = (left + used).saturating_sub(json_size(&again.0));
        *slot = again;
    }
    let lost = rendered.iter().any(|(_, _, lost)| *lost);
    for ((at, item), (value, _, _)) in items.into_iter().zip(rendered) {
        placed[at] = Some((item.category, value));
    }
    (room - left, lost)
}

/// Adds every request to `out` under its category, in the order asked, and says whether any
/// left something out. Explicit reads are filled first, up to most of the budget.
pub(super) fn assemble(items: Vec<Item>, budget: usize, out: &mut Map<String, Value>) -> bool {
    let mut placed: Vec<Option<(Category, Value)>> = items.iter().map(|_| None).collect();
    let (reads, rest): (Vec<Numbered>, Vec<Numbered>) = items.into_iter().enumerate().partition(|(_, item)| item.category == Category::Read);
    // However greedy the reads, every other request keeps room to say what it is; with nothing
    // else asked, the reads may take it all.
    let reads_room = if rest.is_empty() { budget } else { (budget - budget / READ_SHARE_DIVISOR).min(budget.saturating_sub(rest.len() * MIN_ITEM)) };
    let (used, reads_cut) = place_fairly(reads, reads_room, &mut placed);
    let (_, rest_cut) = place_fairly(rest, budget - used, &mut placed);
    for (category, value) in placed.into_iter().flatten() {
        out.entry(category.key()).or_insert_with(|| json!([])).as_array_mut().expect("a category is a list").push(value);
    }
    reads_cut || rest_cut
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(number: usize, text: &str) -> Line {
        Line { text: format!("{number}:{text}"), hit: true, number, definition: false, matched: None }
    }

    /// Many files each showing fewer hits than they have: every header carries a ` (N hits)`
    /// the size estimate leaves out, and the label escapes to six bytes a character.
    fn search(label: &str) -> Item {
        let blocks = (0..40).map(|at| Block { path: format!("src/file_{at:02}.rs"), matched: 100, groups: vec![Group { symbol: Some(format!("fn f{at} 1-9")), lines: vec![line(1, "needle()"), line(2, "needle()")] }] }).collect();
        let mut item = Item::new(Category::Search, head(&[("pattern", json!(label)), ("matches", json!(4000)), ("files", json!(40))]), Body::Files(blocks));
        item.total_lines = 4_000;
        item
    }

    #[test]
    fn shrinking_always_keeps_a_short_error() {
        let mut map = head(&[("path", json!("p".repeat(400))), ("error", json!(format!("Refused: {}", "x".repeat(400)))), ("count", json!(3))]);
        assert!(shrink(&mut map, 64, "path"));
        assert!(map["error"].as_str().unwrap().starts_with("Refused"), "{map:?}");
        assert!(map_size(&map) <= 64, "{map:?}");
    }

    #[test]
    fn files_that_do_not_fit_are_named() {
        let mut out = Map::new();
        let Body::Files(blocks) = search("needle").body else { unreachable!() };
        render_files(&blocks, SEARCH_CAP, &mut out);
        let more = out["more_files"].as_str().unwrap();
        assert!(out["text"].is_string());
        // Two fifths of the room name files; with a third the replay lost a file it had named.
        assert!(more.matches("src/file_").count() >= 23, "{more}");
        assert_eq!(name_more(&["a (1)".into(), "b (1)".into(), "c (1)".into()], 33), "a (1), and 2 more");
        assert_eq!(name_more(&["a (1)".into(), "b (1)".into()], 0), "2 files");
    }

    #[test]
    fn a_lone_file_that_does_not_fit_is_named_when_its_name_fits() {
        assert_eq!(name_more(&["a (1)".into()], 10), "a (1)");
        assert_eq!(name_more(&["a (1)".into()], 0), "1 file");
        assert_eq!(name_more(&["a (1)".into(), "b (1)".into()], 9), "2 files");
        // The `, ` before a last name counts too.
        let long = format!("{} (1)", "l".repeat(21));
        assert_eq!(name_more(&["a (1)".into(), long.clone()], 33), "a (1), and 1 more");
        assert_eq!(name_more(&["a (1)".into(), long.clone()], 34), format!("a (1), {long}"));
        // A name is measured as it is written in JSON: each quote takes two bytes.
        let quoted = r#""""" (1)"#.to_owned();
        assert_eq!(name_more(std::slice::from_ref(&quoted), 10), "1 file");
        assert_eq!(name_more(std::slice::from_ref(&quoted), 14), quoted);
        assert!(json_len(&name_more(std::slice::from_ref(&quoted), 13)) <= 13);
    }

    #[test]
    fn a_cut_read_never_points_on_with_a_clipped_path() {
        let path = format!("src/{}.rs", "p".repeat(300));
        let lines = plain_lines((1..=100).map(|at| format!("{at}:line {at}")).collect::<Vec<_>>());
        let mut item = Item::new(Category::Read, head(&[("path", json!(path)), ("from", json!(1)), ("to", json!(100)), ("total_lines", json!(100))]), Body::Lines(lines));
        item.read = Some(ReadSpan { path: path.clone(), first: 1, upper: None });
        for cap in (40..2_000).step_by(3) {
            let (value, _, _) = render(&item, cap);
            if let Some(next) = value.get("next") {
                assert!(next.as_str().unwrap().starts_with(&format!("{path}:")), "{cap}: {next}");
            }
        }
    }

    #[test]
    fn a_file_with_no_room_for_a_line_is_named_not_shown_bare() {
        let block = Block { path: "p".repeat(380), matched: 1, groups: vec![Group { symbol: None, lines: vec![line(1, &"x".repeat(50))] }] };
        let mut out = Map::new();
        render_files(&[block], 400, &mut out);
        assert!(out.get("text").is_none(), "{out:?}");
        assert!(out["more_files"].is_string());
    }

    /// Omitted lines, omitted files or a request shrunk to its name each leave something out;
    /// a clipped line alone does not.
    #[test]
    fn a_request_says_what_it_left_out() {
        let lines = plain_lines((1..=100).map(|at| format!("{at}:line {at}")).collect::<Vec<_>>());
        let read = Item::new(Category::Read, head(&[("path", json!("a.rs"))]), Body::Lines(lines));
        let (value, cut, lost) = render(&read, 300);
        assert!(cut && lost && value.get("omitted_files").is_none(), "{value}");
        let blocks = (0..20).map(|at| Block { path: format!("src/file_{at:02}.rs"), matched: 0, groups: vec![] }).collect();
        let files = Item::new(Category::Search, head(&[("pattern", json!("x"))]), Body::Files(blocks));
        let (value, cut, lost) = render(&files, 120);
        assert!(cut && lost && value.get("omitted_lines").is_none() && value.get("omitted_files").is_some(), "{value}");
        let (value, cut, lost) = render(&search(&"\u{1}".repeat(195)), 40);
        assert!(cut && lost, "{value}");
        let mut clipped = Item::new(Category::Read, head(&[("path", json!("a.rs"))]), Body::Lines(plain_lines(["1:short".to_owned()])));
        clipped.clipped_lines = 1;
        let (value, cut, lost) = render(&clipped, 2_000);
        assert!(cut && !lost && value["clipped_lines"] == 1, "{value}");
    }

    /// A clipped line keeps as much as its room holds in JSON, not a sixth of it; with room for
    /// fewer than `MIN_CLIPPED` characters the line is left out.
    #[test]
    fn a_clipped_ascii_line_fills_its_room() {
        let lines = [Line { text: "2556:export function selectSession(id: string, options: SelectOptions = {}) {".into(), hit: true, number: 2556, definition: true, matched: None }];
        let taken = take_lines(&lines, 40);
        assert!(taken.text.starts_with("2556:export function sel"), "{:?}", taken.text);
        assert!(taken.used <= 40 && taken.used >= 36, "{} bytes: {:?}", taken.used, taken.text);
        assert_eq!((taken.shown_lines, taken.clipped, taken.shown_hits, taken.used), (1, 1, 1, json_len(&taken.text)));
        let escaped = [Line { text: format!("1:{}", "\u{1}".repeat(60)), hit: true, number: 1, definition: false, matched: None }];
        let taken = take_lines(&escaped, 200);
        assert!(taken.used <= 200 && taken.text.chars().count() > MIN_CLIPPED, "{} bytes", taken.used);
        let taken = take_lines(&lines, 30);
        assert_eq!((taken.shown_lines, taken.used, taken.text.as_str()), (0, 0, ""));
    }

    /// A hit line too long for its room loses its start, not its match (UTF-8 before it).
    #[test]
    fn a_clipped_hit_line_shows_its_match() {
        let lines = [Line { matched: Some(2 + 80), ..line(1, &format!("{}needle() and then more", "é".repeat(80))) }];
        let taken = take_lines(&lines, 70);
        assert!(taken.text.starts_with("1:…") && taken.text.contains("needle("), "{:?}", taken.text);
        assert_eq!(taken.text.chars().skip(3).take_while(|&ch| ch == 'é').count(), MATCH_LEAD, "{:?}", taken.text);
        assert!(taken.used <= 70 && taken.used == json_len(&taken.text), "{}", taken.used);
        // A match that already fits keeps the line's start.
        let early = [Line { matched: Some(2), ..line(1, &format!("needle {}", "x".repeat(200))) }];
        assert!(take_lines(&early, 70).text.starts_with("1:needle"));
    }

    fn context(number: usize, text: &str) -> Line {
        Line { hit: false, ..line(number, text) }
    }

    /// Council repro 2: long context lines ahead of a hit used the room, and the file showed
    /// context under its hit count with the hit itself missing.
    #[test]
    fn a_cut_group_keeps_its_hit_ahead_of_its_context() {
        let long = "x".repeat(300);
        let block = Block { path: "AGENTS.md".into(), matched: 1, groups: vec![Group { symbol: None, lines: vec![context(35, &long), context(36, &long), line(37, "pandacode:agents window event"), context(38, &long)] }] };
        let (text, done) = render_block(&block, 200).expect("the hit fits");
        assert!(text.contains("37:pandacode:agents"), "{text}");
        assert!(!text.contains("35:") && !text.contains("36:"), "{text}");
        assert_eq!(done.shown_lines, 1);
    }

    /// Council repro 1: a group with only context left in its room was shown, and the definition
    /// group after it was lost. A group with no hit is never shown; definitions come first.
    #[test]
    fn a_block_shows_its_definition_before_other_groups_and_never_a_hitless_group() {
        let filler = "y".repeat(90);
        let block = Block {
            path: "src/main.ts".into(),
            matched: 3,
            groups: vec![
                Group { symbol: Some("function markTraySeen 2540-2555".into()), lines: vec![line(2541, &format!("selectSession {filler}")), line(2550, &format!("selectSession {filler}"))] },
                Group { symbol: None, lines: vec![context(2555, &format!("function markTraySeen {filler}")), Line { definition: true, ..line(2556, "export function selectSession(id: string) {") }] },
            ],
        };
        let (text, _) = render_block(&block, 170).expect("the definition fits");
        assert!(text.contains("2556:export function selectSession"), "{text}");
        let hitless = Block { path: "a.rs".into(), matched: 1, groups: vec![Group { symbol: Some("fn a 1-9".into()), lines: vec![context(1, "only context")] }] };
        assert!(render_block(&hitless, 400).is_none());
    }

    #[test]
    fn a_rendered_request_never_passes_its_cap() {
        for label in ["needle".to_owned(), "\u{1}".repeat(195)] {
            for cap in (40..3_000).step_by(7) {
                let (value, _, _) = render(&search(&label), cap);
                let size = serde_json::to_string(&value).unwrap().len();
                assert!(size <= cap, "{size} > {cap} for a {}-byte label", label.len());
            }
        }
    }
}
