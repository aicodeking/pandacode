use super::{
    lex::{indent_of, Language, Lexed},
    limit::Limit,
    symbols::{extract, qualified_by, qualified_matches, Enclosing, Symbol, LINE_METADATA_BYTES},
};
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};

fn limit() -> Limit {
    Limit::new(Arc::default())
}

fn symbols(path: &str, text: &str) -> Vec<Symbol> {
    extract(path, text, &limit())
}

fn names(path: &str, text: &str) -> Vec<(String, &'static str, usize, usize)> {
    symbols(path, text).into_iter().map(|s| (s.name, s.kind, s.line, s.end)).collect()
}

fn has(found: &[(String, &'static str, usize, usize)], name: &str, kind: &str, line: usize, end: usize) {
    assert!(found.iter().any(|s| s.0 == name && s.1 == kind && s.2 == line && s.3 == end), "{name} {kind} {line}-{end} not in {found:?}");
}

#[test]
fn rust_definitions_and_block_ends() {
    let text = r#"pub struct Foo<'a> { x: &'a str }
/// fn not_this()
const LIMIT: usize = 3;
impl<'a> Display for Foo<'a> {
    pub(crate) async fn bar(&self) -> char {
        let brace = '{';
        let s = "}}}";
        '}'
    }
}
/* fn commented() {
} */
pub trait Tr {
    fn sig(&self);
}
macro_rules! mac { () => {} }
mod m;
"#;
    let found = names("a.rs", text);
    has(&found, "Foo", "struct", 1, 1);
    has(&found, "LIMIT", "const", 3, 3);
    has(&found, "Display for Foo<'a>", "impl", 4, 10);
    has(&found, "bar", "fn", 5, 9);
    has(&found, "Tr", "trait", 13, 15);
    has(&found, "sig", "fn", 14, 14);
    has(&found, "mac", "macro", 16, 16);
    has(&found, "m", "mod", 17, 17);
    assert!(!found.iter().any(|s| s.0 == "commented" || s.0 == "not_this"), "{found:?}");
}

#[test]
fn rust_one_line_impls_and_attribute_prefixed_items() {
    let found = names("a.rs", "impl Foo for Bar { fn x(&self) {} }\n#[inline] pub fn fast() {}\n#[cfg(test)] mod tests {\n}\n#[derive(Debug)] struct S;\n");
    has(&found, "Foo for Bar", "impl", 1, 1);
    has(&found, "fast", "fn", 2, 2);
    has(&found, "tests", "mod", 3, 4);
    has(&found, "S", "struct", 5, 5);
}

#[test]
fn rust_signatures_spread_over_lines() {
    let found = names("a.rs", "fn long(\n    a: [u8; 3],\n) -> u8\nwhere\n    u8: Copy,\n{\n    1\n}\nfn next() {}\n");
    has(&found, "long", "fn", 1, 8);
    has(&found, "next", "fn", 9, 9);
}

#[test]
fn keyword_led_names_may_be_common_words() {
    let found = names("a.rs", "impl A {\n    pub fn new() -> Self {\n        Self\n    }\n    fn match_it() {}\n}\n");
    has(&found, "new", "fn", 2, 4);
    let found = names("a.py", "def try_it():\n    pass\ndef delete():\n    pass\n");
    has(&found, "delete", "function", 3, 4);
}

#[test]
fn rust_raw_strings_do_not_confuse_the_scan() {
    let text = "const A: &str = r\"C:\\\";\nfn one() {\n    let s = r#\"{ fn fake() \"quoted\" {\"#;\n    let b = br##\"\n}\nfn fake_two() {}\n\"##;\n}\nfn two() {}\n";
    let found = names("a.rs", text);
    has(&found, "one", "fn", 2, 8);
    has(&found, "two", "fn", 9, 9);
    assert!(!found.iter().any(|s| s.0.starts_with("fake")), "{found:?}");
}

#[test]
fn one_bad_literal_cannot_poison_the_rest_of_a_file() {
    let filler = "// filler\n".repeat(40);
    let found = names("a.rs", &format!("const A: &str = \"oops;\n{filler}fn real() {{\n}}\n"));
    has(&found, "real", "fn", 42, 43);
    let found = names("a.ts", &format!("const a = `oops;\n{filler}export function real() {{\n}}\n"));
    has(&found, "real", "function", 42, 43);
}

#[test]
fn script_regex_literals_do_not_open_strings() {
    let text = "function one(a) {\n  const x = a.replace(/`+/g, '').split(/[\"/]/);\n  return /'/.test(a) ? 1 : a / 2;\n}\nfunction two() {\n  return <div>a</div>;\n}\nfunction three(a) {\n  if (a) return /\"/;\n  typeof /`/;\n}\nfunction four() {\n}\n";
    let found = names("a.tsx", text);
    has(&found, "one", "function", 1, 4);
    has(&found, "two", "function", 5, 7);
    has(&found, "three", "function", 8, 11);
    has(&found, "four", "function", 12, 13);
}

#[test]
fn regex_literals_jsx_and_attributes_keep_block_ends() {
    let found = names("a.js", "function a(x){return /`/.test(x);}\nfunction b() {\n}\nfunction c() {\n}\n");
    has(&found, "a", "function", 1, 1);
    has(&found, "b", "function", 2, 3);
    has(&found, "c", "function", 4, 5);
    let found = names("a.jsx", "function a() {\n  return <p>It`s here</p>;\n}\nfunction b() {\n}\n");
    has(&found, "a", "function", 1, 3);
    has(&found, "b", "function", 4, 5);
    let found = names("a.js", "function a(x) {\n  return /{/.test(x);\n}\nfunction b() {\n}\n");
    has(&found, "a", "function", 1, 3);
    has(&found, "b", "function", 4, 5);
    let found = names("a.py", "def a():\n    x = \"(\"\n    return x\ndef b():\n    \"\"\"Doc\nclass Fake is not code\n    \"\"\"\n");
    has(&found, "a", "function", 1, 3);
    has(&found, "b", "function", 4, 7);
    assert!(!found.iter().any(|s| s.0 == "Fake"), "{found:?}");
    let found = names("a.sh", "cat <<EOF\nit's a heredoc\nEOF\nafter() {\n}\n");
    has(&found, "after", "function", 4, 5);
    let found = names("a.rb", "class A\n  def a = 1\n  def b\n  end\nend\n");
    has(&found, "a", "method", 2, 2);
    let found = names("a.rs", "#[test] fn x() {\n}\n");
    has(&found, "x", "fn", 1, 2);
}

#[test]
fn a_tagged_template_is_still_a_template() {
    let found = names("a.ts", "const q = gql`\n  function fake() {\n`;\nconst r = css`a { }`;\nfunction b() {\n}\n");
    has(&found, "b", "function", 5, 6);
    assert!(!found.iter().any(|s| s.0 == "fake"), "{found:?}");
}

#[test]
fn script_template_substitutions_hold_code() {
    let text = "function one(a) {\n  return `x ${a ? `y ${a}` : '}'} z`;\n}\nfunction two() {\n  return `{`;\n}\n";
    let found = names("a.ts", text);
    has(&found, "one", "function", 1, 3);
    has(&found, "two", "function", 4, 6);
}

#[test]
fn script_definitions() {
    let text = "export async function load(a: string): Promise<void> {\n  if (a) {\n  }\n}\nexport default class App extends B {\n  private run(x: number): void {\n    return;\n  }\n  static async get(): Promise<void> {\n  }\n}\nexport const add = (a, b) => {\n  return a + b;\n};\nconst LIMIT = 3;\nexport interface Props {\n  a: string;\n}\ntype T = string;\nconst tpl = `\nfunction fake() {\n`;\n";
    for file in ["a.ts", "a.tsx", "a.js", "a.jsx", "a.mjs"] {
        let found = names(file, text);
        has(&found, "load", "function", 1, 4);
        has(&found, "App", "class", 5, 11);
        has(&found, "run", "method", 6, 8);
        has(&found, "get", "method", 9, 10);
        has(&found, "add", "function", 12, 14);
        has(&found, "LIMIT", "const", 15, 15);
        has(&found, "Props", "interface", 16, 18);
        has(&found, "T", "type", 19, 19);
        assert!(!found.iter().any(|s| s.0 == "if" || s.0 == "fake"), "{found:?}");
    }
}

#[test]
fn script_class_arrow_fields_and_multi_line_methods() {
    let text = "class A {\n  private run = async (a: string) => {\n    go();\n  };\n  async load(\n    a: string,\n    b: number,\n  ): Promise<void> {\n    other(\n      a,\n    );\n  }\n}\n";
    let found = names("a.ts", text);
    has(&found, "run", "method", 2, 4);
    has(&found, "load", "method", 5, 12);
    assert!(!found.iter().any(|s| s.0 == "other"), "{found:?}");
}

#[test]
fn python_uses_indentation_and_skips_strings() {
    let text = "LIMIT = 3\nclass A(B):\n    def run(\n        self,\n    ):\n        pass\n\n    async def go(self):\n        return 1\n\ndef top():\n    x = 1\n\n# trailing\n";
    let found = names("a.py", text);
    has(&found, "LIMIT", "const", 1, 1);
    has(&found, "A", "class", 2, 9);
    has(&found, "run", "function", 3, 6);
    has(&found, "go", "function", 8, 9);
    has(&found, "top", "function", 11, 12);

    let text = "def a(x=\"(\"):\n    \"\"\"Doc\ndef fake():\nat column zero\n    \"\"\"\n# low comment\n    return x\ndef b():\n    y = ')'\n    return [\n1,\n    ]\n";
    let found = names("a.py", text);
    has(&found, "a", "function", 1, 7);
    has(&found, "b", "function", 8, 12);
    assert!(!found.iter().any(|s| s.0 == "fake"), "{found:?}");
}

#[test]
fn go_definitions_and_groups() {
    let go = names("a.go", "package a\ntype T struct {\n\tx int\n}\nfunc (t *T) Run(a int) error {\n\treturn nil\n}\nfunc top() {}\ntype (\n\tFoo struct {\n\t\ty int\n\t}\n\tBar int\n)\nconst (\n\tA = 1\n\t// note\n\tB = 2\n)\nvar z = 1\n");
    has(&go, "T", "type", 2, 4);
    has(&go, "Run", "func", 5, 7);
    has(&go, "top", "func", 8, 8);
    has(&go, "Foo", "type", 10, 12);
    has(&go, "Bar", "type", 13, 13);
    has(&go, "A", "const", 16, 16);
    has(&go, "B", "const", 18, 18);
    has(&go, "z", "const", 20, 20);
    assert!(!go.iter().any(|s| s.0 == "y" || s.0 == "x"), "{go:?}");
}

#[test]
fn java_kotlin_swift_and_triple_quotes() {
    let java = names("A.java", "public final class A extends B {\n    private static final int X = 1;\n    public List<String> run(int a) throws E {\n        return foo(a);\n    }\n    void other() {\n        new Thing(1) {\n        };\n    }\n}\n");
    has(&java, "A", "class", 1, 10);
    has(&java, "run", "method", 3, 5);
    has(&java, "other", "method", 6, 9);
    assert!(!java.iter().any(|s| s.0 == "foo" || s.0 == "Thing"), "{java:?}");

    let kotlin = names("a.kt", "data class P(val a: Int)\nsuspend fun <T> List<T>.run(a: Int): Int {\n    return a\n}\nval top = 1\nval text = \"\"\"\nfun fake() {\n\"\"\"\nfun after() {}\n");
    has(&kotlin, "P", "class", 1, 1);
    has(&kotlin, "run", "function", 2, 4);
    has(&kotlin, "top", "const", 5, 5);
    has(&kotlin, "after", "function", 9, 9);
    assert!(!kotlin.iter().any(|s| s.0 == "fake"), "{kotlin:?}");

    let swift = names("a.swift", "public struct S {\n    private func run(_ a: Int) -> Int {\n        a\n    }\n    init(x: Int) {\n    }\n}\nextension S {\n}\nlet doc = \"\"\"\nfunc fake() {\n\"\"\"\nfunc after() {}\n");
    has(&swift, "S", "class", 1, 7);
    has(&swift, "run", "function", 2, 4);
    has(&swift, "init", "function", 5, 6);
    has(&swift, "S", "class", 8, 9);
    has(&swift, "after", "function", 13, 13);
    assert!(!swift.iter().any(|s| s.0 == "fake"), "{swift:?}");

    let java = names("A.java", "class A {\n    String t = \"\"\"\n    void fake() {\n    \"\"\";\n    void real() {\n    }\n}\n");
    has(&java, "real", "method", 5, 6);
    assert!(!java.iter().any(|s| s.0 == "fake"), "{java:?}");
}

#[test]
fn c_family_definitions_and_indented_methods() {
    let c = names("a.c", "#define MAX 3\nstruct foo {\n\tint x;\n};\nstatic int run(int a)\n{\n\tif (a) {\n\t\treturn call(a);\n\t}\n}\nint decl(int a);\ntypedef int num;\nvoid A::method(int b) {\n}\nvoid other() {\n\tloop_each(a) {\n\t}\n}\n");
    has(&c, "MAX", "macro", 1, 1);
    has(&c, "foo", "class", 2, 4);
    has(&c, "run", "function", 5, 10);
    has(&c, "num", "type", 12, 12);
    has(&c, "method", "function", 13, 14);
    assert!(!c.iter().any(|s| s.0 == "decl" || s.0 == "call" || s.0 == "loop_each"), "{c:?}");

    let cpp = names("a.hpp", "class Widget {\npublic:\n    Widget(int a) : a_(a) {\n    }\n    virtual int size() const override {\n        return a_;\n    }\n    int decl();\n    ~Widget() {\n    }\n};\n");
    has(&cpp, "Widget", "class", 1, 11);
    has(&cpp, "Widget", "method", 3, 4);
    has(&cpp, "size", "method", 5, 7);
    has(&cpp, "~Widget", "method", 9, 10);
    assert!(!cpp.iter().any(|s| s.0 == "decl"), "{cpp:?}");
}

#[test]
fn ruby_definitions() {
    let ruby = names("a.rb", "module M\n  class C\n    def self.run(a)\n      a\n    end\n    def ok?; true; end\n    def a.bar\n      1\n    end\n    def double(x) = x * 2\n    def name=(v)\n      @n = v\n    end\n    def ==(o)\n      true\n    end\n  end\nend\n");
    has(&ruby, "M", "module", 1, 18);
    has(&ruby, "C", "class", 2, 17);
    has(&ruby, "run", "method", 3, 5);
    has(&ruby, "ok?", "method", 6, 6);
    has(&ruby, "bar", "method", 7, 9);
    has(&ruby, "double", "method", 10, 10);
    has(&ruby, "name=", "method", 11, 13);
    has(&ruby, "==", "method", 14, 16);
}

#[test]
fn php_and_shell_definitions() {
    let php = names("a.php", "<?php\nfinal class C {\n    const X = 1;\n    public static function run($a) {\n        return $a;\n    }\n}\nfunction top() {}\n");
    has(&php, "C", "class", 2, 7);
    has(&php, "X", "const", 3, 3);
    has(&php, "run", "function", 4, 6);
    has(&php, "top", "function", 8, 8);

    let shell = names("a.sh", "#!/bin/sh\nbuild() {\n  echo '}'\n}\nfunction clean {\n  rm x\n}\ncat <<'EOF'\nfake() {\nEOF\nafter() {\n  cat <<-END\n\tnot_this() {\n\tEND\n}\n");
    has(&shell, "build", "function", 2, 4);
    has(&shell, "clean", "function", 5, 7);
    has(&shell, "after", "function", 11, 15);
    assert!(!shell.iter().any(|s| s.0 == "fake" || s.0 == "not_this"), "{shell:?}");
}

#[test]
fn enclosing_is_the_innermost_definition_in_one_pass() {
    let found = symbols("a.rs", "impl A {\n    fn b() {\n        c();\n    }\n}\nfn d() {}\nlet x;\n");
    let mut enclosing = Enclosing::new(&found);
    assert_eq!(enclosing.at(1).unwrap().name, "A");
    assert_eq!(enclosing.at(3).unwrap().name, "b");
    assert_eq!(enclosing.at(5).unwrap().name, "A");
    assert_eq!(enclosing.at(6).unwrap().name, "d");
    assert!(enclosing.at(7).is_none());
    assert!(symbols("notes.txt", "fn a() {}").is_empty());
}

#[test]
fn qualifiers_match_a_whole_word_of_the_container() {
    let found = symbols("a.rs", "impl Display for Foo<'a> {\n    fn run() {}\n}\nimpl Food {\n    fn run() {}\n}\n");
    let run = found.iter().filter(|s| s.name == "run").collect::<Vec<_>>();
    assert!(qualified_by(&found, run[0], "Foo") && qualified_by(&found, run[0], "Display"));
    assert!(!qualified_by(&found, run[1], "Foo") && qualified_by(&found, run[1], "Food"));
}

/// Each of these took minutes while every definition scanned ahead to the end of the file.
#[test]
fn hostile_files_stay_linear() {
    let cases = [
        ("unclosed.rs", "fn a() {\n".repeat(100_000)),
        ("unclosed.ts", "function a() {\n".repeat(70_000)),
        ("noend.rb", "def a\n".repeat(150_000)),
        ("flat.py", "def a():\n".repeat(100_000)),
        ("one_line.rs", format!("fn a() {{ {} }}\n", "{}".repeat(450_000))),
        ("signatures.rs", "fn a(\n".repeat(150_000)),
        ("closed.rs", "fn a() {}\n".repeat(100_000)),
    ];
    for (path, text) in cases {
        let started = Instant::now();
        let found = symbols(path, &text);
        let line = found.len() / 2;
        let mut enclosing = Enclosing::new(&found);
        (1..=line).for_each(|line| {
            enclosing.at(line);
        });
        assert!(started.elapsed() < Duration::from_secs(60), "{path}: {:?}", started.elapsed());
    }
}

#[test]
fn an_expired_limit_ends_extraction() {
    let done = Limit::lasting(Duration::ZERO, Arc::default());
    assert!(extract("a.rs", &"fn a() {}\n".repeat(10), &done).is_empty());
    assert!(done.was_cut());
}

#[test]
fn deeply_nested_multi_brace_spans_are_exact_and_bounded() {
    let count = 8_000;
    let mut text = (0..count).map(|index| format!("fn f{index}() {{ {{\n")).collect::<String>();
    text.push_str(&"}\n}\n".repeat(count));
    let budget = Limit::lasting(Duration::from_secs(10), Arc::default());
    let started = Instant::now();
    let found = extract("nested.rs", &text, &budget);
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(!budget.was_cut(), "nested brace resolution exhausted its budget");
    assert_eq!(found.len(), count);
    for (index, symbol) in found.iter().enumerate() {
        assert_eq!((symbol.name.as_str(), symbol.line, symbol.end), (format!("f{index}").as_str(), index + 1, 3 * count - 2 * index));
    }
    let stopped = Limit::new(Arc::new(AtomicBool::new(true)));
    let started = Instant::now();
    assert!(extract("nested.rs", &text, &stopped).is_empty());
    assert!(stopped.was_cut());
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn deeply_nested_python_spans_keep_literal_and_bracket_lines() {
    // Stay below the definition rule's 2,000-byte line cap, even at the deepest indent.
    let count = 1_800;
    let mut text = (0..count).map(|index| format!("{}def f{index}():\n", " ".repeat(index))).collect::<String>();
    text.push_str(&format!("{}value = [\n", " ".repeat(count)));
    text.push_str(&"0,\n".repeat(8_000));
    text.push_str("]\n\n# low comment\n");
    text.push_str(&format!("{}doc = \"\"\"\n", " ".repeat(count)));
    text.push_str("\n# literal comment\ndef fake():\n\"\"\"\n\n# trailing comment\n");
    let end = text.lines().count() - 2;
    let budget = Limit::lasting(Duration::from_secs(10), Arc::default());
    let started = Instant::now();
    let found = extract("nested.py", &text, &budget);
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(!budget.was_cut(), "nested indentation resolution exhausted its budget");
    assert_eq!(found.len(), count);
    for (index, symbol) in found.iter().enumerate() {
        assert_eq!((symbol.line, symbol.end), (index + 1, end));
    }
    let stopped = Limit::new(Arc::new(AtomicBool::new(true)));
    let started = Instant::now();
    assert!(extract("nested.py", &text, &stopped).is_empty());
    assert!(stopped.was_cut());
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn block_openings_declarations_and_reordered_signatures_keep_spans() {
    let found = names("spans.rs", "fn outer(\nfn inner() {\n) {\n}\n}\nfn declared();\nfn double() { {\n}\n}\nmod unclosed {\n");
    has(&found, "outer", "fn", 1, 5);
    has(&found, "inner", "fn", 2, 5);
    has(&found, "declared", "fn", 6, 6);
    has(&found, "double", "fn", 7, 9);
    has(&found, "unclosed", "mod", 10, 10);
    // A malformed signature can find its opening after a later definition's opening.
    let found = names("reordered.rs", "mod container {\nfn outer(\n} ->\nfn inner() {\n{\n}\n}\n");
    has(&found, "container", "mod", 1, 3);
    has(&found, "outer", "fn", 2, 6);
    has(&found, "inner", "fn", 4, 7);
}

#[test]
fn lexing_checks_stop_and_deadline_before_recording_lines() {
    let lines = vec!["fn f() { {"; 8_000];
    for done in [Limit::new(Arc::new(AtomicBool::new(true))), Limit::lasting(Duration::ZERO, Arc::default())] {
        let lex = Lexed::new(&lines, Language::Rust, &done);
        assert!(lex.inside_literal.is_empty());
        assert!(done.was_cut());
    }
}

#[test]
fn python_spans_match_the_line_scan_at_mixed_bracket_and_indent_depths() {
    // Include incomplete expressions and strings: the outline is intentionally tolerant of
    // malformed code, so a stack that assumes valid nesting would change existing spans.
    let fragments = ["def f():", "class C:", "value = [", "]", "return (", ")", "pass", "", "# comment", "\"\"\"", "literal text"];
    let mut state = 37u64;
    for _ in 0..100 {
        let mut text = String::new();
        for _ in 0..100 {
            state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let fragment = fragments[(state >> 32) as usize % fragments.len()];
            let indent = (state >> 16) as usize % 8;
            text.push_str(&format!("{}{fragment}\n", " ".repeat(indent)));
        }
        let lines = text.lines().collect::<Vec<_>>();
        let lex = Lexed::new(&lines, Language::Python, &limit());
        for symbol in symbols("mixed.py", &text) {
            let start = symbol.line - 1;
            let mut end = start;
            for index in start..lines.len() {
                let trimmed = lines[index].trim();
                if index > start && lex.inside_literal[index] {
                    end = index;
                } else if trimmed.is_empty() || (index > start && trimmed.starts_with('#')) {
                    continue;
                } else if index > start && lex.parens_before[index] <= lex.parens_before[start] && indent_of(lines[index]) <= indent_of(lines[start]) {
                    break;
                } else {
                    end = index;
                }
            }
            assert_eq!(symbol.end, end + 1, "{symbol:?} in {text}");
        }
    }
}

#[test]
fn jsx_text_with_an_apostrophe_or_a_url_keeps_blocks_apart() {
    let text = "export function A() {\n  return (\n    <div>\n      {open && <span>Can't save</span>}\n      {show && <p>see https://x</p>}\n    </div>\n  );\n}\nfunction B() {\n  return 1;\n}\nfunction C() {\n  return 2;\n}\n";
    let found = names("a.tsx", text);
    has(&found, "A", "function", 1, 8);
    has(&found, "B", "function", 9, 11);
    has(&found, "C", "function", 12, 14);
}

/// JSX text with a quote and an expression, and a `default:` label right
/// before a comment, each once shifted every later block end.
#[test]
fn jsx_apostrophes_and_a_label_before_a_comment_keep_block_ends() {
    let found = names("a.tsx", "function A() {\n  return <p>It's {x ? 'a' : 'b'}</p>;\n}\nfunction B() {\n}\n");
    has(&found, "A", "function", 1, 3);
    has(&found, "B", "function", 4, 5);
    let found = names("d.js", "function D(x) {\n  switch (x) {\n    default:// fall through {\n  }\n  return 1;\n}\nfunction E() {\n  return 2;\n}\n");
    has(&found, "D", "function", 1, 6);
    has(&found, "E", "function", 7, 9);
    let found = names("u.tsx", "function U() {\n  return <a>https://example.com</a>;\n}\n");
    has(&found, "U", "function", 1, 3);
}

#[test]
fn inline_object_defaults_and_types_keep_the_whole_script_signature() {
    for (text, end) in [
        ("export const loadUser = (options = {}) =>\n  validate(options);\n", 2),
        ("export function loadUser(input: {id: string}):\nUser {\n  return validate(input);\n}\n", 4),
        ("export const loadUser = (\n  options = {},\n) =>\n  validate(\n    options\n  );\n", 6),
    ] {
        let found = names("user.ts", text);
        has(&found, "loadUser", "function", 1, end);
    }
    let found = names("one.rs", "fn a() {}\npub struct Foo<'a> { x: &'a str }\nimpl Foo for Bar { fn x(&self) {} }\n");
    for (index, symbol) in found.iter().enumerate() {
        assert_eq!((symbol.2, symbol.3), (index + 1, index + 1));
    }
}

#[test]
fn failed_regex_and_stray_quote_scans_stay_linear() {
    for text in ["/[".repeat(40_000), "a'".repeat(40_000), "a` ".repeat(27_000), "a' ".repeat(20_000) + &" ".repeat(20_000)] {
        let lines = [text.as_str()];
        let started = Instant::now();
        let lex = Lexed::new(&lines, Language::Script, &limit());
        assert_eq!(lex.inside_literal.len(), 1);
        assert!(started.elapsed() < Duration::from_millis(500), "{:?}", started.elapsed());
        for done in [Limit::new(Arc::new(AtomicBool::new(true))), Limit::lasting(Duration::ZERO, Arc::default())] {
            let started = Instant::now();
            assert!(Lexed::new(&lines, Language::Script, &done).inside_literal.is_empty());
            assert!(started.elapsed() < Duration::from_millis(500));
            assert!(done.was_cut());
        }
    }
}

#[test]
fn a_single_long_line_can_expire_during_lexing() {
    for prefix in ["", "\"", "/*", "a` "] {
        let text = format!("{prefix}{}", "x".repeat(16 * 1024 * 1024));
        let done = Limit::lasting(Duration::from_millis(2), Arc::default());
        let started = Instant::now();
        let lex = Lexed::new(&[text.as_str()], Language::Script, &done);
        assert!(lex.inside_literal.is_empty(), "{prefix:?}: the interrupted line must not be recorded");
        assert!(done.was_cut());
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}

#[test]
fn parse_metadata_is_bounded_and_released_after_each_extraction() {
    let text = "\n".repeat(1_048_576);
    let budget = limit();
    assert!(extract("blank.js", &text, &budget).is_empty());
    assert!(budget.was_cut());
    // The refused parse took no scratch bytes, and reservations return their full allowance.
    assert!(budget.reserve_parse_bytes(super::limit::MAX_PARSE_BYTES).is_some());
    let budget = Limit::with_parse_bytes(LINE_METADATA_BYTES);
    for _ in 0..3 {
        let found = extract("a.rs", "fn a() {}\n", &budget);
        assert_eq!(found.len(), 1);
        assert!(!budget.was_cut());
    }
    let held = budget.reserve_parse_bytes(1).unwrap();
    assert!(extract("a.rs", "fn a() {}\n", &budget).is_empty());
    assert!(budget.was_cut());
    drop(held);
    assert_eq!(extract("a.rs", "fn a() {}\n", &budget).len(), 1);
}

#[test]
fn qualified_lookup_is_linear_and_honors_stopped_limits() {
    let symbols: Vec<_> = (1..=80_000).map(|line| Symbol { name: "run".into(), qualifier: None, kind: "fn", line, end: line }).collect();
    let budget = limit();
    let mut count = 0;
    let started = Instant::now();
    qualified_matches(&symbols, Some("Missing"), |symbol| symbol.name == "run", &budget, |_| count += 1);
    assert_eq!(count, 0);
    assert!(started.elapsed() < Duration::from_millis(500), "{:?}", started.elapsed());
    for qualifier in [None, Some("Missing")] {
        let done = Limit::new(Arc::new(AtomicBool::new(true)));
        qualified_matches(&symbols, qualifier, |_| panic!("a stopped lookup must not test candidates"), &done, |_| panic!("a stopped lookup must not yield candidates"));
        assert!(done.was_cut());
    }
}

#[test]
fn linear_qualifiers_match_the_reference_including_same_line_duplicates() {
    let mut state = 37u64;
    for _ in 0..100 {
        let mut symbols = Vec::new();
        for line in 1..=12 {
            for _ in 0..5 {
                state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                let name = ["Foo", "Bar", "impl Foo for Bar", "Food", "run"][(state >> 32) as usize % 5];
                let end = line + (state as usize % 4);
                let symbol = Symbol { name: name.into(), qualifier: None, kind: "fn", line, end };
                symbols.push(symbol.clone());
                if state.is_multiple_of(3) {
                    symbols.push(symbol);
                }
            }
        }
        for qualifier in [None, Some("Foo"), Some("Bar"), Some("run"), Some("Missing")] {
            let expected: Vec<_> = symbols.iter().filter(|symbol| qualifier.is_none_or(|q| qualified_by(&symbols, symbol, q))).collect();
            let mut actual = Vec::new();
            qualified_matches(&symbols, qualifier, |_| true, &limit(), |symbol| actual.push(symbol));
            assert_eq!(actual, expected, "{qualifier:?}");
        }
    }
}

#[test]
fn non_nested_receiver_methods_keep_their_qualifiers() {
    for (path, text, qualifier, name) in [
        ("a.go", "func (s *Server) Run() {}\n", "Server", "Run"),
        ("a.go", "func (Server) Run() {}\n", "Server", "Run"),
        ("a.cpp", "void A::method() {}\n", "A", "method"),
        ("a.cpp", "std::string A::method() {}\n", "A", "method"),
        ("a.cpp", "const Foo *A::method() {}\n", "A", "method"),
        ("a.cpp", "void Foo::Bar::baz() {}\n", "Bar", "baz"),
        ("a.cpp", "Foo::Bar::Bar() {}\n", "Bar", "Bar"),
        ("a.kt", "fun Foo.bar() {}\n", "Foo", "bar"),
        ("a.rb", "def Foo.bar\nend\n", "Foo", "bar"),
    ] {
        let found = symbols(path, text);
        let symbol = found.iter().find(|symbol| symbol.name == name).unwrap();
        assert!(qualified_by(&found, symbol, qualifier), "{path}: {found:?}");
        let mut matched = Vec::new();
        qualified_matches(&found, Some(qualifier), |symbol| symbol.name == name, &limit(), |symbol| matched.push(symbol));
        assert_eq!(matched, [symbol]);
        let mut wrong = Vec::new();
        qualified_matches(&found, Some(&format!("{qualifier}Extra")), |_| true, &limit(), |symbol| wrong.push(symbol));
        assert!(wrong.is_empty());
    }
}

#[test]
fn cpp_qualified_calls_are_not_definitions() {
    for text in [
        "    std::for_each(v.begin(), v.end(), [](int x) {\n",
        "    QObject::connect(btn, &QPushButton::clicked, this, [this] {\n",
        "    spdlog::info(\"x {}\",\n",
        "Foo::Bar::baz() {}\n",
        "inline A::method() {}\n",
        "constexpr A::method() {}\n",
        "namespace foo {\n    {\n        A::A()\n    }\n}\n",
        "class C {\n    void f() {\n        A::A()\n    }\n};\n",
        "void f() {\n    A::A()\n}\n",
        "void f() {\nA::A()\n}\n",
        "void f() {\n    void A::method() {\n    }\n}\n",
        "void f() {\n    std::for_each(v.begin(), v.end(), [](int x) {\n    });\n    QObject::connect(btn, &QPushButton::clicked, this, [this] {\n    });\n    spdlog::info(\"x {}\",\n        1);\n    A::A();\n}\n",
    ] {
        let found = symbols("a.cpp", text);
        assert!(found.iter().all(|symbol| symbol.qualifier.is_none()), "{text}: {found:?}");
        assert!(found.iter().all(|symbol| !["for_each", "connect", "info", "baz", "A", "method"].contains(&symbol.name.as_str())), "{text}: {found:?}");
    }
}

#[test]
fn cpp_qualified_definitions_accept_types_and_constructors_in_namespaces() {
    for (declaration, qualifier, name) in [
        ("void A::method() {}", "A", "method"),
        ("std::string ns::A::method() {}", "ns::A", "method"),
        ("Foo* A::make() {}", "A", "make"),
        ("Foo&A::get() {}", "A", "get"),
        ("A::A() {}", "A", "A"),
        ("A::~A() {}", "A", "A"),
        ("inline A::A() {}", "A", "A"),
        ("inline void A::method() {}", "A", "method"),
    ] {
        for text in [format!("{declaration}\n"), format!("namespace foo {{\n    {declaration}\n}}\n"), format!("namespace foo\n{{\n    {declaration}\n}}\n")] {
            let found = symbols("a.cpp", &text);
            assert!(found.iter().any(|symbol| symbol.name == name && symbol.qualifier.as_deref() == Some(qualifier)), "{text}: {found:?}");
        }
    }
}

#[test]
fn cpp_namespace_and_linkage_blocks_keep_qualified_definitions_and_reject_calls() {
    for header in [
        "namespace {", "namespace /* anon */ {", "namespace { // internal",
        "namespace\n{", "namespace /* anon */\n{",
        "inline namespace v1 {", "inline namespace v1::v2 {",
        "namespace a::b {", "namespace a::inline b {",
        "namespace foo { // helpers", "namespace foo { /* helpers */",
        "namespace foo // helpers\n{", "namespace foo /* helpers */\n{",
        "namespace outer {\nnamespace {", "namespace outer {\ninline namespace inner {",
        "extern \"C\" {", "extern \"C\"\n{", "extern \"C++\" { // linkage",
    ] {
        let closes = "}\n".repeat(header.matches('{').count());
        let text = format!("{header}\nvoid Foo::bar() {{\n    std::for_each(v.begin(), v.end(), [](int x) {{\n    }});\n    QObject::connect(btn, signal, this, [this] {{\n    }});\n    spdlog::info(\"value\",\n        1);\n    Widget::helper();\n    Widget::Widget()\n    void Widget::bogus() {{}}\n}}\nFoo::Foo() {{}}\n{closes}void After::done() {{}}\n");
        let found = symbols("a.cpp", &text);
        for (qualifier, name) in [("Foo", "bar"), ("Foo", "Foo"), ("After", "done")] {
            assert!(found.iter().any(|symbol| symbol.name == name && symbol.qualifier.as_deref() == Some(qualifier)), "{header}: {found:?}");
        }
        assert!(found.iter().all(|symbol| !symbol.name.is_empty()), "{header}: {found:?}");
        assert!(found.iter().all(|symbol| !["for_each", "connect", "info", "helper", "Widget", "bogus"].contains(&symbol.name.as_str())), "{header}: {found:?}");
    }
}

#[test]
fn cpp_commented_named_containers_keep_clean_names_and_spans() {
    for (header, qualifier, name) in [
        ("inline namespace v1 { // version", None, "v1"),
        ("namespace a::b { /* nested */", Some("a"), "b"),
        ("namespace a::inline b {", Some("a"), "b"),
        ("namespace a::b::c {", Some("a::b"), "c"),
        ("inline namespace v1::v2 {", Some("v1"), "v2"),
        ("namespace foo // helpers\n{", None, "foo"),
        ("class Foo { // implementation", None, "Foo"),
        ("struct Foo { /* implementation */", None, "Foo"),
        ("union Foo // implementation\n{", None, "Foo"),
        ("enum class Foo { // implementation", None, "Foo"),
    ] {
        let text = format!("{header}\n    void Widget::method() {{}}\n}};\n");
        let found = symbols("a.cpp", &text);
        let container = found.iter().find(|symbol| symbol.name == name && symbol.kind == "class").unwrap_or_else(|| panic!("{header}: {found:?}"));
        assert_eq!(container.qualifier.as_deref(), qualifier, "{header}: {found:?}");
        assert_eq!((container.line, container.end), (1, text.lines().count()), "{header}: {found:?}");
        assert!(found.iter().any(|symbol| symbol.name == "method" && symbol.qualifier.as_deref() == Some("Widget")), "{header}: {found:?}");
    }
}

/// The one definition `qualifier::name` (or `name` alone) finds, as `path#…` and `symbols` do.
fn lookup<'a>(found: &'a [Symbol], qualifier: Option<&str>, name: &str) -> Vec<&'a Symbol> {
    let mut matched = Vec::new();
    qualified_matches(found, qualifier, |symbol| symbol.name == name, &limit(), |symbol| matched.push(symbol));
    matched
}

#[test]
fn nested_cpp_namespaces_are_found_by_their_qualified_names() {
    let text = "namespace a::b {\nvoid run() {}\n}\nnamespace a::inline b::c {\nint go() { return 1; }\n}\nnamespace x {\nvoid run() {}\n}\n";
    let found = symbols("a.cpp", text);
    let b = found.iter().find(|symbol| symbol.name == "b").unwrap();
    let c = found.iter().find(|symbol| symbol.name == "c").unwrap();
    assert_eq!((b.qualifier.as_deref(), b.line, b.end), (Some("a"), 1, 3), "{found:?}");
    assert_eq!((c.qualifier.as_deref(), c.line, c.end), (Some("a::b"), 4, 6), "{found:?}");
    assert_eq!(lookup(&found, Some("a"), "b"), [b]);
    assert_eq!(lookup(&found, None, "b"), [b]);
    assert_eq!(lookup(&found, Some("b"), "c"), [c]);
    assert!(lookup(&found, Some("x"), "b").is_empty());
    // What a nested namespace holds is qualified by every part of its path.
    let run = found.iter().find(|symbol| symbol.name == "run" && symbol.line == 2).unwrap();
    assert_eq!(lookup(&found, Some("a"), "run"), [run]);
    assert_eq!(lookup(&found, Some("b"), "run"), [run]);
    assert_eq!(lookup(&found, Some("x"), "run").len(), 1);
    assert_eq!(lookup(&found, Some("c"), "go").len(), 1);
    assert_eq!(lookup(&found, Some("a"), "go").len(), 1);
}

#[test]
fn cpp_one_line_definitions_are_extracted_with_their_qualifiers() {
    for (text, qualifier, name, line) in [
        ("class Vec {\n public:\n    int size() const { return n_; }\n};\n", None, "size", 3),
        ("inline int Vec::cap() const { return c_; }\n", Some("Vec"), "cap", 1),
        ("Foo::Foo() : x_(0) { init(); }\n", Some("Foo"), "Foo", 1),
        ("struct S {\n    static int zero() { return 0; };\n};\n", None, "zero", 2),
        ("static int zero() { return 0; };\n", None, "zero", 1),
        ("int add(int a, int b) { return a + b; }\n", None, "add", 1),
        ("namespace ns {\ninline int Vec::cap() const { return c_; }\nFoo::Foo() : x_(0) { init(); }\n}\n", Some("Vec"), "cap", 2),
        ("namespace ns {\ninline int Vec::cap() const { return c_; }\nFoo::Foo() : x_(0) { init(); }\n}\n", Some("Foo"), "Foo", 3),
        ("namespace ns {\nclass Vec {\n    int size() const { return n_; }\n    void put(int v) { data_.push_back(v); }\n};\n}\n", None, "put", 4),
    ] {
        let found = symbols("a.cpp", text);
        let symbol = found.iter().find(|symbol| symbol.name == name && symbol.line == line).unwrap_or_else(|| panic!("{text}: {found:?}"));
        assert_eq!((symbol.qualifier.as_deref(), symbol.end), (qualifier, line), "{text}: {found:?}");
        assert_eq!(lookup(&found, qualifier, name), [symbol], "{text}");
    }
    // Definitions after a one-liner still resolve, so its span ends on its own line.
    let found = symbols("a.cpp", "int a() { return 1; }\nvoid Foo::b() {\n    x();\n}\n");
    assert!(found.iter().any(|symbol| symbol.name == "b" && symbol.qualifier.as_deref() == Some("Foo") && (symbol.line, symbol.end) == (2, 4)), "{found:?}");
}

#[test]
fn cpp_declarations_and_one_line_calls_stay_out() {
    for text in [
        "int size() const;\n", "void foo(int a);\n", "int Vec::cap() const;\n",
        "class Vec {\n    int size() const;\n    void foo(int a);\n};\n",
        "void f() {\n    std::for_each(v.begin(), v.end(), [](int x) { use(x); });\n    QObject::connect(b, s, this, [this] { run(); });\n    Widget::helper();\n    std::vector<int>::push_back(x);\n    Box<int>::helper();\n    if (x) { return y; }\n    while (go) { step(); }\n}\n",
        "void f() {\n    Box<int>::Box() { init(); }\n    void Box<T>::put(T v) { use(v); }\n}\n",
    ] {
        let found = symbols("a.cpp", text);
        let unexpected = ["size", "foo", "cap", "for_each", "connect", "helper", "push_back", "Box", "put", "if", "while"];
        assert!(found.iter().all(|symbol| !unexpected.contains(&symbol.name.as_str())), "{text}: {found:?}");
    }
}

#[test]
fn cpp_template_out_of_line_definitions_keep_their_class_qualifier() {
    for (text, qualifier, name) in [
        ("template <typename T>\nvoid Box<T>::put(T v) {\n    items.push_back(v);\n}\n", "Box", "put"),
        ("template <typename K, typename V>\ninline int Map<K, V>::size() const { return n_; }\n", "Map", "size"),
        ("template <typename T>\nBox<T>::Box() {}\n", "Box", "Box"),
        ("template <typename T>\nBox<T>::~Box() {}\n", "Box", "Box"),
        ("template <typename T> template <typename U>\nvoid Outer<T>::Inner<U>::run() {\n}\n", "Outer::Inner", "run"),
        ("namespace ns {\ntemplate <typename T>\nvoid Box<T>::put(T v) {\n}\n}\n", "Box", "put"),
    ] {
        let found = symbols("a.cpp", text);
        let symbol = found.iter().find(|symbol| symbol.name == name).unwrap_or_else(|| panic!("{text}: {found:?}"));
        assert_eq!((symbol.kind, symbol.qualifier.as_deref()), ("function", Some(qualifier)), "{text}: {found:?}");
        let last = qualifier.rsplit("::").next();
        assert_eq!(lookup(&found, last, name), [symbol], "{text}");
    }
}

#[test]
fn java_one_line_methods_are_extracted_and_declarations_are_not() {
    let text = "class Account {\n    public int getBalance() { return balance; }\n    private static String id() { return \"x\"; }\n    public void reset() { count = 0; }\n    void run() {\n        if (x) { return y; }\n        while (go) { step(); }\n        synchronized (lock) { n++; }\n    }\n}\ninterface Shape {\n    int getBalance();\n    abstract void reset();\n}\n";
    let found = names("A.java", text);
    for (name, line) in [("getBalance", 2), ("id", 3), ("reset", 4)] {
        has(&found, name, "method", line, line);
    }
    has(&found, "run", "method", 5, 9);
    assert_eq!(found.iter().filter(|s| s.0 == "getBalance" || s.0 == "reset").count(), 2, "{found:?}");
    assert!(found.iter().all(|s| !["if", "while", "synchronized"].contains(&s.0.as_str())), "{found:?}");
}

#[test]
fn script_one_line_class_methods_are_extracted_and_signatures_are_not() {
    let text = "class Cart {\n  count(): number { return this.items.length; }\n  get total(): number { return this.sum; }\n  set value(v: number) { this.v = v; }\n  private reset() { this.n = 0; }\n  async ping(): Promise<void> { await noop(); }\n  run() {\n    if (ok) { return 1; }\n    for (const x of xs) { f(x); }\n    try { g(); } catch (e) { log(e); }\n    switch (k) { default: break; }\n    items.forEach((x) => { total += x; });\n  }\n}\ninterface Counter {\n  count(): number;\n  shape(): { n: number };\n}\nabstract class Base {\n  abstract reset(): void;\n  count(): number;\n  count(n?: number): number { return n ?? 0; }\n}\n";
    let found = names("a.ts", text);
    for (name, line) in [("count", 2), ("total", 3), ("value", 4), ("reset", 5), ("ping", 6), ("count", 22)] {
        has(&found, name, "method", line, line);
    }
    has(&found, "run", "method", 7, 13);
    assert_eq!(found.iter().filter(|s| ["count", "reset", "shape"].contains(&s.0.as_str())).count(), 3, "{found:?}");
    assert!(found.iter().all(|s| !["if", "for", "catch", "switch", "forEach"].contains(&s.0.as_str())), "{found:?}");
}
