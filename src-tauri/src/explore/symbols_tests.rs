use super::{
    lex::{indent_of, Language, Lexed},
    limit::Limit,
    symbols::{extract, qualified_by, Enclosing, Symbol},
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
