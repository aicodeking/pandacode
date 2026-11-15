use super::*;

fn outputs(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    image_outputs(&serde_json::json!({ "command": command }), ShellInput::Any, &mut out);
    out
}

/// Outputs of a record run in `/w`, with that prefix removed (absolute paths elsewhere stay).
fn under_w(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    image_outputs(&serde_json::json!({ "command": command, "cwd": "/w" }), ShellInput::Any, &mut out);
    out.into_iter().map(|path| path.strip_prefix("/w/").map_or_else(|| path.clone(), str::to_owned)).collect()
}

fn in_dir(command: &str, cwd: &str) -> Vec<String> {
    let mut out = Vec::new();
    script_outputs(command, SHELL_NESTING, Shell { cwd: Some(cwd.to_owned()), ..Shell::default() }, &mut out);
    out
}

#[test]
fn tool_image_shell_splits_quoted_words_and_commands() {
    assert_eq!(
        split_commands("cd '/tmp/a b' && echo \"x \\\"y\\\"\" | cat # done\nls a\\ b; (pwd)"),
        vec![vec!["cd", "/tmp/a b"], vec!["&&"], vec!["echo", "x \"y\""], vec!["cat"], vec!["ls", "a b"], vec!["("], vec!["pwd"], vec![")"]]
    );
    assert_eq!(split_commands("ffmpeg -i a.mp4 \\\n  out.png 2>&1"), vec![vec!["ffmpeg", "-i", "a.mp4", "out.png", "2>&1"]]);
}

#[test]
fn tool_image_shell_tool_names() {
    for name in ["bash", "command", "shell", "run_terminal_cmd", "exec_command", "local_shell", "mcp__x__bash", "running: cd /tmp && ffmpeg …"] {
        assert_eq!(shell_tool(name), Some(ShellInput::Any), "{name}");
    }
    assert_eq!(shell_tool("ran ffmpeg, python3"), Some(ShellInput::JsonOnly));
    for name in ["ran ", "ran", "rand", "running", "pandacode_vm_exec", "mcp__pandacode__pandacode_vm_exec", "read", "bash_output", "webfetch"] {
        assert_eq!(shell_tool(name), None, "{name}");
    }
}

#[test]
fn tool_image_shell_reads_the_working_directory() {
    let codex = |text: &str, kind| {
        let mut out = Vec::new();
        image_outputs(&Value::String(text.into()), kind, &mut out);
        out
    };
    assert_eq!(codex("/bin/zsh -lc \"cd sub && screencapture a.png\"\nWorking directory: /repo/", ShellInput::Any), ["/repo/sub/a.png"]);
    assert_eq!(codex("screencapture a.png\nWorking directory: relative", ShellInput::Any), Vec::<String>::new());
    assert_eq!(codex("screencapture /tmp/a.png", ShellInput::JsonOnly), Vec::<String>::new());
    let json = |input: Value| {
        let mut out = Vec::new();
        image_outputs(&Value::String(input.to_string()), ShellInput::JsonOnly, &mut out);
        out
    };
    assert_eq!(json(serde_json::json!({"command": "screencapture a.png", "workdir": "/w"})), ["/w/a.png"]);
    assert_eq!(json(serde_json::json!({"command": "screencapture a.png", "cwd": "/"})), ["/a.png"]);
    assert_eq!(json(serde_json::json!({"command": "screencapture a.png", "workdir": "rel"})), Vec::<String>::new());
    assert_eq!(json(serde_json::json!({"command": "cd /tmp && screencapture a.png", "workdir": "/w"})), ["/tmp/a.png"]);
}

#[test]
fn tool_image_shell_finds_image_outputs() {
    let outputs = under_w;
    assert_eq!(outputs("screencapture -x /tmp/shot.png"), ["/tmp/shot.png"]);
    assert_eq!(outputs("/usr/sbin/screencapture -R 0,0,10,10 '/tmp/a b.png' && open /tmp/a.png"), ["/tmp/a b.png"]);
    assert_eq!(outputs("ffmpeg -y -i in.mp4 -frames:v 1 frame.png 2>/dev/null"), ["frame.png"]);
    assert_eq!(outputs("ffmpeg -i in.mp4 out.png > log.txt"), ["out.png"]);
    // An unknown flag never swallows `-i`, so the input is not mistaken for an output.
    assert_eq!(outputs("ffmpeg -noautorotate -i /Users/x/in.png out.png"), ["out.png"]);
    assert_eq!(outputs("ffmpeg -nostdin -autorotate -i in.png -c:v png -q:v 2 -update 1 out.png"), ["out.png"]);
    assert_eq!(outputs("ffmpeg -i in.mp4 -frames:v 1 -fps_mode passthrough a.png"), ["a.png"]);
    assert_eq!(outputs("ffmpeg -i in.mp4 -noaccurate_seek a.png"), ["a.png"]);
    assert_eq!(outputs("sips -Z 400 big.png --out small.png"), ["small.png"]);
    assert_eq!(outputs("sips -s format jpeg a.png -o b.jpg"), ["b.jpg"]);
    assert_eq!(outputs("magick in.svg -resize 50% out.png"), ["out.png"]);
    assert_eq!(outputs("convert a.png b.webp"), ["b.webp"]);
    assert_eq!(outputs("rsvg-convert -w 64 icon.svg -o icon.png"), ["icon.png"]);
    assert_eq!(outputs("rsvg-convert icon.svg --output=icon.png"), ["icon.png"]);
    assert_eq!(outputs("chrome --headless --screenshot=/tmp/page.png https://x"), ["/tmp/page.png"]);
    assert_eq!(outputs("npx playwright screenshot --screenshot /tmp/p.png"), ["/tmp/p.png"]);
    assert_eq!(outputs("sudo FOO=1 env screencapture s.png"), ["s.png"]);
    assert_eq!(outputs("bash -lc 'mkdir -p out && screencapture out/s.png'"), ["out/s.png"]);
    let mut argv = Vec::new();
    image_outputs(&serde_json::json!({ "command": ["zsh", "-c", "screencapture /tmp/z.png"] }), ShellInput::Any, &mut argv);
    assert_eq!(argv, ["/tmp/z.png"]);
    let mut plain = Vec::new();
    image_outputs(&Value::String("screencapture /tmp/plain.png".into()), ShellInput::Any, &mut plain);
    assert_eq!(plain, ["/tmp/plain.png"]);
}

#[test]
fn tool_image_shell_ignores_mere_mentions() {
    for command in [
        "cat /tmp/shot.png",
        "ls -la /tmp/shot.png",
        "open /tmp/shot.png",
        "file /tmp/shot.png",
        "echo screencapture /tmp/shot.png",
        "ffmpeg -i /tmp/shot.png",
        "magick identify /tmp/shot.png",
        "sips -g pixelWidth /tmp/shot.png",
        "screencapture -x",
        "# screencapture /tmp/shot.png",
        "cp /tmp/shot.png /tmp/copy.png",
    ] {
        assert!(outputs(command).is_empty(), "{command}");
    }
}

#[test]
fn tool_image_shell_matches_the_shared_produced_images_fixture() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("../../../tests/fixtures/produced-images.json")).expect("fixture parses");
    assert!(cases.len() >= 40);
    for case in &cases {
        let command = case["command"].as_str().expect("command");
        // Every image the command writes is served, so the row's one path need only be among them.
        let found = case["cwd"].as_str().map_or_else(|| outputs(command), |cwd| in_dir(command, cwd));
        match case["produced"].as_str() {
            Some(produced) => assert!(found.iter().any(|path| path == produced), "{command}: {found:?}"),
            None => assert!(found.is_empty(), "{command}: {found:?}"),
        }
    }
}

#[test]
fn tool_image_shell_follows_variables_loops_and_redirects() {
    let outputs = under_w;
    assert_eq!(outputs("D=/tmp/d; export E=$D/e; screencapture $E/a.png"), ["/tmp/d/e/a.png"]);
    assert_eq!(outputs("D=/tmp/d; screencapture \"${D}/a.png\"; screencapture '$D/b.png'; screencapture \\$D/c.png"), ["/tmp/d/a.png"]);
    assert_eq!(outputs("for t in 3 4; do\n  ffmpeg -ss $t -i v.mp4 -frames:v 1 f$t.jpg\ndone; screencapture f$t.png"), ["f3.jpg"]);
    assert_eq!(outputs("curl -s u > a.png; curl u 2> b.png; curl u >/dev/null; curl u &>c.png; curl u >| d.png"), ["a.png", "c.png", "d.png"]);
    assert_eq!(outputs("ffmpeg -i a.png -i b.png -filter_complex \"$(for i in 0 1; do printf \"[$i]\"; done)hstack\" s.png"), ["s.png"]);
    assert_eq!(outputs("ffmpeg -i v.mp4 -map 0 a.png -map 0 b.png"), ["a.png", "b.png"]);
    assert_eq!(outputs("cat > s.sh <<'EOF'\nscreencapture /tmp/in.png\nEOF\nscreencapture /tmp/out.png"), ["/tmp/out.png"]);
    assert_eq!(outputs("echo $(screencapture /tmp/sub.png)"), Vec::<String>::new());
    assert_eq!(outputs("ffmpeg -f concat -safe 0 -i <(for f in a b; do echo \"file '$f.png'\"; done) -vf tile=2x1 s.png"), ["s.png"]);
}

#[test]
fn tool_image_shell_subshells_give_the_directory_back() {
    assert_eq!(outputs("(cd /tmp/x && screencapture a.png) && screencapture b.png"), ["/tmp/x/a.png"]);
    assert_eq!(in_dir("(cd /tmp/x && screencapture a.png) && screencapture b.png", "/w"), ["/tmp/x/a.png", "/w/b.png"]);
    assert_eq!(in_dir("cd /tmp/x; popd; screencapture c.png", "/w"), Vec::<String>::new());
    assert_eq!(in_dir("cd \"$D\" && screencapture c.png", "/w"), Vec::<String>::new());
    assert_eq!(in_dir("cd && screencapture c.png", "/w"), Vec::<String>::new());
}

/// Claude's `Bash` records carry no directory and the agent's cwd persists
/// between calls, so a relative output is only trusted under a known directory.
#[test]
fn tool_image_shell_relative_outputs_need_a_known_directory() {
    for command in ["ffmpeg -y -i demo.mp4 -frames:v 1 intro.jpg", "screencapture shot.png", "cd sub && screencapture a.png", "cd ~/x && screencapture a.png", "curl u > a.png"] {
        assert!(outputs(command).is_empty(), "{command}");
    }
    assert_eq!(outputs("cd /tmp/w && ffmpeg -i demo.mp4 intro.jpg"), ["/tmp/w/intro.jpg"]);
    assert_eq!(outputs("cd /tmp/w && cd sub && screencapture ./a.png"), ["/tmp/w/sub/a.png"]);
    assert!(outputs("screencapture ~/a.png").is_empty(), "the webview never requests ~ paths");
    assert_eq!(in_dir("ffmpeg -i demo.mp4 intro.jpg", "/repo"), ["/repo/intro.jpg"]);
    let mut argv = Vec::new();
    image_outputs(&serde_json::json!({ "command": ["ffmpeg", "-i", "d.mp4", "f.png"], "cwd": "/r/" }), ShellInput::Any, &mut argv);
    assert_eq!(argv, ["/r/f.png"]);
    let mut none = Vec::new();
    image_outputs(&serde_json::json!({ "command": ["ffmpeg", "-i", "d.mp4", "f.png"] }), ShellInput::Any, &mut none);
    assert!(none.is_empty());
}

#[test]
fn tool_image_shell_skips_commands_that_never_run() {
    assert!(outputs("true || screencapture /tmp/a.png").is_empty());
    assert!(outputs("false && screencapture /tmp/a.png && screencapture /tmp/b.png").is_empty());
    assert_eq!(outputs("false && screencapture /tmp/a.png || screencapture /tmp/b.png"), ["/tmp/b.png"]);
    assert_eq!(outputs(": || screencapture /tmp/a.png; screencapture /tmp/c.png"), ["/tmp/c.png"]);
    assert_eq!(outputs("make && screencapture /tmp/a.png"), ["/tmp/a.png"]);
    assert_eq!(outputs("false || screencapture /tmp/a.png"), ["/tmp/a.png"]);
    assert_eq!(outputs("true && screencapture /tmp/a.png"), ["/tmp/a.png"]);
}

#[test]
fn tool_image_shell_in_place_and_download_outputs() {
    let outputs = under_w;
    assert_eq!(outputs("mogrify -resize 50% a.png b.jpg"), ["a.png", "b.jpg"]);
    assert_eq!(outputs("magick mogrify -strip x.png"), ["x.png"]);
    assert!(outputs("magick convert in.png -strip -").is_empty());
    assert_eq!(outputs("curl -fsSL -o /tmp/x.png https://e/x.png"), ["/tmp/x.png"]);
    assert_eq!(outputs("curl --output=y.webp https://e/y.webp"), ["y.webp"]);
    assert!(outputs("curl -O https://e/x.png").is_empty());
}

#[test]
fn tool_image_shell_caps_doubling_variables() {
    let doubling = format!("A=xxxxxxxxxx; {}screencapture /tmp/$A.png; screencapture /tmp/ok.png", "A=$A$A; ".repeat(40));
    let started = std::time::Instant::now();
    let found = outputs(&doubling);
    assert!(started.elapsed() < std::time::Duration::from_millis(50), "took {:?}", started.elapsed());
    // `$A` outgrew the cap, so it is unknown and names no image.
    assert_eq!(found, ["/tmp/ok.png"]);
    let mut shell = Shell::default();
    shell.vars.insert("A".to_owned(), "x".repeat(VALUE_LIMIT));
    assert_eq!(expand_within("$A$A", &shell, VALUE_LIMIT), "$A$A");
    assert_eq!(expand_within("$A", &shell, VALUE_LIMIT).len(), VALUE_LIMIT);
    assert!(!record_assignments(&[], &mut shell));
    let long = format!("B={}", "y".repeat(VALUE_LIMIT + 1));
    assert!(record_assignments(&[long], &mut shell));
    assert!(!shell.vars.contains_key("B"));
    // Many words of a capped size stay within the per-command budget.
    let words = format!("screencapture {}/tmp/z.png", "$A ".repeat(40));
    let argv: Vec<String> = split_commands(&words).remove(0);
    let expanded = expand_all(&argv, &shell);
    assert!(expanded.iter().map(String::len).sum::<usize>() <= EXPANDED_LIMIT + VALUE_LIMIT * 2);
    assert_eq!(expanded.last().map(String::as_str), Some("/tmp/z.png"));
    assert_eq!(outputs("D=/tmp/x; screencapture $D/a.png"), ["/tmp/x/a.png"]);
}

/// Inline scripts, as `scriptImage` in shell-intent-scripts.ts reads them (each
/// expectation was checked against `describeShell(command, _, { cwd: '/w' })`).
#[test]
fn tool_image_shell_reads_literal_saves_in_inline_scripts() {
    let none = Vec::<String>::new();
    for (command, expected) in [
        ("node -e \"p.screenshot({path:'a.png'})\"", vec!["a.png"]),
        ("node -e \"p.screenshot({ clip: {x:0}, path: 'a.png' })\"", vec!["a.png"]),
        ("node -e \"p.screenshot({path:`a.png`})\"", vec!["a.png"]),
        ("python3 -c \"p.screenshot(path='a.png', full_page=True)\"", vec!["a.png"]),
        ("python3.12 -c \"im.save( 'a.jpg' )\"", vec!["a.jpg"]),
        ("python3 -c 'im.save(\"a.PNG\")'", vec!["a.PNG"]),
        ("python3 -c \"im.save('a.png'); im.save('b.gif')\"", vec!["a.png", "b.gif"]),
        ("python3 -c \"savefig('./c.webp')\"", vec!["c.webp"]),
        ("python3 - <<'EOF' > /tmp/log.txt\nim.save('/tmp/a.png')\nEOF", vec!["/tmp/a.png"]),
        ("python3 <<< \"im.save('h.png')\"", vec!["h.png"]),
        ("D=/tmp/d; python3 -c \"im.save('$D/a.png')\"", vec!["/tmp/d/a.png"]),
        ("(cd /tmp/x && node -pe \"p.screenshot({path:'a.png'})\")", vec!["/tmp/x/a.png"]),
        ("bash -c 'python3 - <<EOF\nim.save(\"/tmp/b.png\")\nEOF'", vec!["/tmp/b.png"]),
        ("sudo env A=1 python3 -u -c \"im.save('s.png')\"", vec!["s.png"]),
        ("npx -y tsx -e \"p.screenshot({path:'t.png'})\"", vec!["t.png"]),
        ("pnpm exec ts-node -e \"p.screenshot({path:'t.png'})\"", vec!["t.png"]),
        ("uv run --with pillow python -c \"im.save('u.png')\"", vec!["u.png"]),
        ("deno run -e \"p.screenshot({path:'d.png'})\"", vec!["d.png"]),
        ("bun x.js <<'EOF'\np.screenshot({path:'/tmp/b.png'})\nEOF", vec!["/tmp/b.png"]),
    ] {
        assert_eq!(under_w(command), expected, "{command}");
    }
    for command in [
        "node -e \"p.screenshot({path: dir + '/x.png'})\"",
        "node -e \"p.screenshot({path: `${dir}/x.png`})\"",
        "python3 -c \"im.save(f)\"",
        "python3 -c \"im.save(f'{name}.png')\"",
        "python3 -c \"im.save('a.tiff'); im.save('notes.txt'); im.save('a.png.txt')\"",
        "python3 -c \"im.save('/tmp/.png')\"",
        "python3 -c \"xsavefig('a.jpg')\"",
        "node -e \"page.screenshot({\n path: '/tmp/a.png' })\"",
        "node -e \"p.screenshot()\" -e \"x({path:'a.png'})\"",
        "D=/tmp/d; python3 - <<EOF\nim.save('$D/a.png')\nEOF",
        "python3 - <<EOF\nim.save('$(pwd)/a.png')\nEOF",
        "cat <<'EOF' | python3 -\nim.save('/tmp/a.png')\nEOF",
        "cat > s.py <<'EOF'\nim.save('/tmp/a.png')\nEOF",
        "python3 -Bc \"im.save('a.png')\"",
        "python -m foo -c \"im.save('a.png')\"",
        "python3 -m x <<'EOF'\nim.save('/tmp/a.png')\nEOF",
        "node --test -e \"p.screenshot({path:'a.png'})\"",
        "deno eval \"p.screenshot({path:'a.png'})\"",
        "deno test -e \"p.screenshot({path:'a.png'})\"",
        "bun -e \"p.screenshot({path:'a.png'})\"",
        "bun run x.ts -e \"p.screenshot({path:'a.png'})\"",
        "yarn tsx -e \"p.screenshot({path:'a.png'})\"",
        "xargs python3 -c \"im.save('a.png')\"",
        "perl -e \"im.save('a.png')\"",
        "ruby -e \"im.save('a.png')\"",
        "python3 x.py <<< \"im.save('a.png')\"",
        "echo \"im.save('/tmp/a.png')\"",
    ] {
        assert_eq!(under_w(command), none, "{command}");
    }
    // Without a known directory a relative save is unknown, as any relative output is.
    assert!(outputs("python3 -c \"im.save('a.png')\"").is_empty());
}

#[test]
fn tool_image_shell_heredoc_bodies_replace_their_tag_word() {
    assert_eq!(split_commands("python3 - <<'EOF' >x\na = '$D'\nEOF\nls"), vec![vec!["python3", "-", "<<", "a = '\u{1}D'", ">x"], vec!["ls"]]);
    assert_eq!(split_commands("node <<A; cat <<B\n1\nA\n2\nB"), vec![vec!["node", "<<", "1"], vec!["cat", "<<", "2"]]);
}
