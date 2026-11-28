//! Which paths may hold credentials, and which folders are too broad to search. Shared by Plan
//! mode's own reads (`sensitive_name`) and `pandacode_explore` (`secret_path`, `refused_entry`,
//! `root_refusal`). Names are compared in lowercase. The `CASES` table in
//! `secret_paths_tests.rs` decides examples for every step in both rules: add a row with each
//! change, and keep the steps below in the order the code runs them.
//!
//! **A path** (`secret_path`) is refused when
//! 1. it is a GitHub workflow (`.github/workflows/x.yml`, which reads secrets by name) — served
//!    in the plain rule unless its name is a key prefix (`id_rsa.yml`); otherwise
//! 2. any part of it is a refused entry (below), except that the plain rule serves token names
//!    (`tokens.json`) under a folder with a design word (`design/`, `src/theme/`); or
//! 3. it is an Android string resource (`res/values*/x.xml`) the strict rule refuses; or
//! 4. it is in a tool's login folder (`.config/gh`) or is a folder-and-file login
//!    (`.docker/config.json`); or
//! 5. it is inside a credential folder (`secrets/`, `keys/`, `my-secrets/`) and is not code,
//!    markup, UI strings (`messages.json`), a doc or page other than one named for production
//!    alone (`secrets/prod.md`), or (in the plain rule) an image (`assets/keys/enter.svg`); or
//! 6. it is inside a token folder (`tokens/`, `api-tokens/`, a design system's as often as a
//!    vault) and is named only for whose they are (`tokens/prod.json`, `tokens/deploy`).
//!
//! Paths are relative to the project root, so a credential folder opened as the root itself
//! (`~/ops/secrets`) keeps its contents: the user chose that folder.
//!
//! **An entry** (`refused_entry`) is judged as named and as each name it may be a copy of
//! (`server.key.bak` → `server.key`). An env template (`.env.example`) is never refused by the
//! explorer. In the plain rule (Standard, Auto edits, Full access; `credential_name`):
//! 1. login dot-names (`.git`, `.ssh`, `.aws`, `.netrc`) are refused, files or folders;
//! 2. any other folder is never refused by its name: steps 5 and 6 above judge its files;
//! 3. env files (`.env`, `prod.env`, `app.env.local`) are refused unless code (`app.env.ts`);
//! 4. key names (`id_rsa`, `NAMES`, `KEY_EXTENSIONS` even before a template ending,
//!    `deploy_key`, `wg0.conf`, `secrets.py`) are refused unless a page about them;
//! 5. other placeholder copies (`secrets.example.yaml`) are served;
//! 6. docs are served unless named for one credential word and production alone
//!    (`prod-passwords.md`): guides to setting them up are what agents need;
//! 7. shell scripts are refused when named only for credentials and whose they are
//!    (`prod-secrets.sh`);
//! 8. token files (`token` or `tokens` as a word, in a text or data type, not design tokens)
//!    and any other name with a credential word are refused, unless code (a component's
//!    template too) or a page about them (`password_reset_form.html`).
//!
//! The strict rule (Plan mode, `strict_name`) refuses whatever the plain rule refuses, and also
//! every unknown dot-name, `STRICT_NAMES`, and any name that mentions a credential, code and
//! docs included. `sensitive_name` is the strict rule without the env-template exemption: Plan
//! mode asks before reading any env file.
use std::path::{Component, Path, PathBuf};

/// Top-level system folders with process environments, devices, service tokens or keychains.
pub(crate) const SYSTEM_ROOTS: &[&str] = &["proc", "sys", "dev", "root", "etc", "var", "library", "private"];
/// Folders directly in the home directory that hold keychains, browser profiles and app data.
pub(crate) const HOME_PRIVATE: &[&str] = &["library", "appdata"];
/// Hidden names that are ordinary project files; under the strict rule every other dot-name may
/// hold secrets (`.ssh`, `.aws`, `.codex`, `.claude`, `.config`, `.local`, `.docker`, `.netrc`…).
const PLAIN_DOT_NAMES: &[&str] = &[".github", ".gitignore", ".gitattributes", ".editorconfig"];
/// File names refused in both rules, whatever their extension; names a credential word or the
/// token rule already covers (`credentials.json`, `token.json`, `.vault-token`) are not repeated.
const NAMES: &[&str] = &[
    "auth.json", "login data", "cookies", "cookies.sqlite", "key4.db", "logins.json", "_netrc",
    ".envrc", ".dev.vars", ".terraformrc", "terraform.rc", ".yarnrc", ".yarnrc.yml", ".pgpass", ".my.cnf", ".mylogin.cnf", ".authinfo", ".passwd-s3fs", ".s3cfg", ".boto", ".dockercfg", ".dockerconfigjson",
    "key.properties", "keystore.properties", "local.properties", "admin.conf", "rclone.conf", "pip.conf", "wallet.dat", "shadow", "wp-config.php",
    "keyfile.json", "pat.txt", ".sentryclirc", "pgpass.conf", "vault_pass.txt", ".vault_pass", ".mcp.json",
];
/// Names refused only by the strict rule: in a project they are build files (Gradle settings, an
/// Ansible inventory); their login copies are refused by folder in `FOLDER_FILES`.
const STRICT_NAMES: &[&str] = &["gradle.properties", "hosts.yml", "hosts.yaml"];
/// Folder and file pairs that hold credentials where the folder alone does not.
const FOLDER_FILES: &[(&str, &str)] = &[
    (".gradle", "gradle.properties"),
    ("gh", "hosts.yml"),
    ("gh", "hosts.yaml"),
    (".cursor", "mcp.json"),
    (".vscode", "mcp.json"),
    (".claude", "settings.local.json"),
    // sops keeps age private keys here.
    ("age", "keys.txt"),
    (".m2", "settings.xml"), (".bundle", "config"), (".docker", "config.json"), (".azure", "accesstokens.json"), (".azure", "msal_token_cache.json"), (".azure", "azureprofile.json"), (".azure", "service_principal_entries.json"),
];
/// Parts of a name that mark a credential file; source files named after what they handle
/// (`id_rsa_parser.rs`, `service_account.py`) are exempt in the plain rule.
const PREFIXES: &[&str] = &["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "ai.pandacode", "firebase-adminsdk"];
/// Credential words, found anywhere in a name (`usage_keychain`, `apikey`).
const CONTAINS: &[&str] = &["credential", "secret", "keychain", "password", "passwd", "creds", "tfstate", "tfvars", "service-account", "service_account", "serviceaccount", "kubeconfig", "api_key", "api-key", "apikey", "private_key", "private-key", "privatekey"];
/// Credential words that count only as whole words: `tokenizer` and `monkeys` are no tokens.
const TOKEN_WORDS: &[&str] = &["token", "tokens"];
/// Key and secret file types, refused in both rules: `.asc` is also AsciiDoc, but ASCII-armored
/// keys use it too, and AsciiDoc is usually `.adoc`. Env files are step 3's.
const KEY_EXTENSIONS: &[&str] = &[".pem", ".key", ".p12", ".pfx", ".p8", ".pk8", ".der", ".ppk", ".keystore", ".jks", ".keytab", ".kdbx", ".gpg", ".asc", ".ovpn", ".keyring"];
/// Code that usually holds the values themselves when named `secrets` (`secrets.py`,
/// `prod.secret.exs`), unlike typed modules such as `secrets.ts` or a `secret.js` helper.
const VALUE_CODE: &[&str] = &["py", "js", "cjs", "mjs", "php", "rb", "tf", "exs"];
/// Under the plain rule, the hidden names that are clearly about credentials.
const CREDENTIAL_DOT_NAMES: &[&str] = &[".git", ".aws", ".ssh", ".gnupg", ".kube", ".gcloud", ".netrc", ".npmrc", ".pypirc", ".envs", ".env.d"];
/// Last parts that make a name a template of placeholders (`.env.example`, `.env.local.sample`,
/// `secrets.example.yaml`). `.env.test` and `.env.development` often hold real keys.
const TEMPLATE_ENDINGS: &[&str] = &["example", "sample", "template", "dist"];
/// Shell scripts are code, yet `secrets.sh` usually exports the values themselves.
const SHELL_EXTENSIONS: &[&str] = &["sh", "bash", "zsh"];
/// Prose docs: guides, served unless named for one credential word and production alone.
const DOCS: &[&str] = &["md", "mdx", "rst", "adoc"];
/// Pages and templates: in a credential folder they show forms, not values (`passwords/new.html.erb`).
const MARKUP: &[&str] = &["html", "htm", "erb", "hbs", "handlebars", "mustache", "ejs", "jinja", "jinja2", "j2", "njk", "twig", "liquid", "pug", "haml", "slim", "jsp"];
/// UI strings named for what they hold, not for a credential (`secrets/messages.json`).
const UI_TEXT: &[&str] = &["messages", "strings", "translations"];
/// Words that say a credential is the production one: a doc named for one credential and one of
/// these lists them (`prod-passwords.md`); any other place is a setup guide (`aws-secrets.md`).
const PRODUCTION: &[&str] = &["prod", "production"];
/// Words that say whose credentials or for where: beside credential words alone they make a
/// script or folder hold them (`aws-secrets.sh`, `my-secrets/`, `api-tokens/`).
const OWNER_WORDS: &[&str] = &[
    "prod", "production", "staging", "stage", "dev", "development", "test", "qa", "uat", "local", "admin", "root", "team", "db", "database", "aws", "gcp", "azure", "github", "gh",
    "gitlab", "ci", "server", "my", "our", "all", "shared", "personal", "old", "new", "api", "deploy",
];
/// Words that make `tokens` design tokens (Style Dictionary, Figma, Tailwind), not logins.
const DESIGN_WORDS: &[&str] = &["design", "theme", "figma", "tailwind", "style", "styles", "color", "colors", "brand"];
/// Images: never a credential, even in a `keys/` folder (`assets/keys/enter.svg`).
const IMAGES: &[&str] = &["svg", "png", "jpg", "jpeg", "gif", "webp", "ico"];
/// Types a token is kept in: `token.txt`, `api.token`, `gh.token.yaml`, `.github_token`; not a
/// `token.html` page or a workflow.
const TOKEN_EXTENSIONS: &[&str] = &["", "txt", "json", "yaml", "yml", "conf", "token"];
/// Templates: `password_reset_form.html` is about credentials when a word in `DOC_WORDS` says
/// what it is; `admin_passwords.html` may hold them. `txt` is for mail templates
/// (`password_reset_subject.txt`); a copy saved as text (`form.key.txt`) names no credential
/// word and stays a copy.
const DOC_EXTENSIONS: &[&str] = &["html", "htm", "erb", "xml", "hbs", "ejs", "jinja", "j2", "twig", "txt"];
/// Words that make a template about credentials (`password_reset_form.html`); any other word
/// (`prod`, `admin`, `github`) may name whose they are.
const DOC_WORDS: &[&str] = &[
    "reset", "forgot", "change", "form", "rotation", "management", "policy", "done", "confirm", "complete", "email", "subject", "instructions", "hashing", "bucket", "providers", "login",
];
/// Words that say what kind of template a file is, not what it does: alongside a `DOC_WORDS`
/// word they are fine (`password_reset_page.html`), alone they are not (`secrets-page.md`).
const LAYOUT_WORDS: &[&str] = &["page", "view", "field", "input", "layout", "fragment"];
/// Backup and editor-copy suffixes: `server.key.bak` is the key, and `private.pem.txt` or
/// `wp-config.php.txt` a copy saved as text. `notes.txt` is still `notes`, nothing secret.
/// `.dist` is a copy too (`server.key.dist`); `.env.dist` stays a template by its full name.
/// `.~` comes before `~` so Emacs's `.~1~` loses both.
const BACKUP_SUFFIXES: &[&str] = &[
    ".~", " copy", ".bak", ".old", ".orig", ".save", ".backup", ".tmp", ".swp", "~", ".copy", ".txt", ".bk", ".bkp", ".dist", ".prev", "-backup", "_backup", "_bak", "-bak", "_old", "-old",
];
/// Folders under `HOME_PRIVATE` or a dot folder of home that hold projects: editor and shell
/// settings and dotfile repos, which hold no logins, and the cloud drives (iCloud Drive and its
/// app folders, Dropbox, OneDrive, Google Drive, Box). Files in them are still judged by name.
const HOME_ALLOWED: &[&str] = &[
    ".config/nvim", ".config/fish", ".config/zed", ".config/helix", ".config/alacritty", ".config/kitty", ".config/wezterm", ".dotfiles", ".emacs.d", ".vim",
    "library/mobile documents", "library/cloudstorage",
    // Other agent apps' git worktrees: projects, not the apps' sessions or logins.
    ".codex/worktrees", ".cursor/worktrees", ".claude/worktrees",
];
/// Dot folders whose `worktrees` folder holds git worktrees (`<repo>/.claude/worktrees/x`),
/// which Plan mode explores like any project.
const WORKTREE_DOTS: &[&str] = &[".claude", ".codex", ".cursor"];
/// Tool folders under `~/.config` and `~/.local/share` that hold logins, home-relative.
const LOGIN_FOLDERS: &[&str] = &[".config/gh", ".config/gcloud", ".config/github-copilot", ".local/share/keyrings"];

/// The strict rule without the env-template exemption, for Plan mode's own reads: anything that
/// could hold a credential, code or not, or a backup of one. `name` is lowercase.
pub(crate) fn sensitive_name(name: &str) -> bool {
    copied_names(name).any(strict_name)
}

/// `.env.example`, `app.env.sample`, `.env.local.example`: placeholders, when nothing before
/// `.env` is a credential name of its own (`my-secrets.env.example` is not exempt). Only the
/// full name is exempt, so a backup of a template is still an env file.
fn env_template(name: &str) -> bool {
    let before = name.find(".env").map_or(name, |at| &name[..at]);
    env_file(name) && TEMPLATE_ENDINGS.contains(&extension(name)) && !strict_name(before)
}

/// A hidden name Plan mode does not know, which may hold secrets.
fn unknown_dot_name(name: &str) -> bool {
    name.starts_with('.') && !PLAIN_DOT_NAMES.contains(&name)
}

fn strict_name(name: &str) -> bool {
    unknown_dot_name(name) || STRICT_NAMES.contains(&name) || env_file(name) || named_credential(name) || token_name(name) || prefixed(name) || mentions_credentials(name)
}

/// The text after a name's last dot, or nothing.
pub(crate) fn extension(name: &str) -> &str {
    name.rsplit_once('.').map_or("", |(_, extension)| extension)
}

fn prefixed(name: &str) -> bool {
    PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

/// A name's words once its credential words are taken out.
struct Words {
    /// Credential words found: `CONTAINS` anywhere, and `extra` as whole words.
    credentials: usize,
    /// A credential word was plural (`passwords`, `creds`, `tokens`).
    plural: bool,
    rest: Vec<String>,
}

/// Splits `name` into its credential words and the rest. `secretary` is not a secret, but the
/// rest of `secretary-credentials.json` still counts.
// ponytail: `secretar` is the one known false friend; switch to word boundaries if more turn up.
fn credential_words(name: &str, extra: &[&str]) -> Words {
    let name = name.replace("secretar", "");
    let mut credentials = 0;
    let rest = CONTAINS.iter().fold(name.clone(), |rest, needle| {
        credentials += rest.matches(needle).count();
        rest.replace(needle, " ")
    });
    // A plural's `s` is left behind on its own (`passwords` → ` s`).
    let mut plural = name.contains("creds");
    let mut words = Vec::new();
    for word in rest.split(|c: char| !c.is_ascii_alphanumeric()).filter(|word| !word.is_empty()) {
        if word == "s" {
            plural = true;
        } else if extra.contains(&word) {
            credentials += 1;
            plural |= word.ends_with('s');
        } else {
            words.push(word.to_owned());
        }
    }
    Words { credentials, plural, rest: words }
}

/// A word of the name says it is about credentials.
fn mentions_credentials(name: &str) -> bool {
    credential_words(name, &[]).credentials > 0
}

/// Every word is on `OWNER_WORDS`, and there is one: `prod`, `github`, `deploy`.
fn only_owners(words: &[String]) -> bool {
    !words.is_empty() && words.iter().all(|word| OWNER_WORDS.contains(&word.as_str()))
}

/// A name that is nothing but credential words (`extra` among them) and `OWNER_WORDS`:
/// `prod-passwords`, `my-secrets`, `secrets` itself.
fn owned_credentials(name: &str, extra: &[&str]) -> bool {
    let words = credential_words(name, extra);
    words.credentials > 0 && (words.rest.is_empty() || only_owners(&words.rest))
}

/// Path step 5's folders: named only for credentials and whose they are (`secrets`, `keys`,
/// `private_keys`, `prod-credentials`, or a backup of one).
fn credential_folder(name: &str) -> bool {
    copied_names(name).any(|name| owned_credentials(name, &["keys"]))
}

/// Path step 6's folders: named only for tokens and whose they are (`tokens`, `api-tokens`).
fn token_folder(name: &str) -> bool {
    copied_names(name).any(|name| owned_credentials(name, TOKEN_WORDS) && name.split(|c: char| !c.is_ascii_alphanumeric()).any(|word| TOKEN_WORDS.contains(&word)))
}

/// `token` (or `tokens` with an extension) as a word of any dot part (`token.txt`, `access_token`,
/// `.github_token`, `api.token`, `tokens.json`), in a file that is neither code nor design tokens;
/// not `tokens.ts` or `tokenizer.json`. A folder `tokens` is path step 6's.
fn token_name(name: &str) -> bool {
    let words: Vec<&str> = name.split(|c: char| !c.is_ascii_alphanumeric()).collect();
    let token = words.iter().any(|&word| word == "token" || (word == "tokens" && name.contains('.')));
    token && !words.iter().any(|word| DESIGN_WORDS.contains(word)) && !source_file(name)
}

/// A template whose name says what it does with credentials (`password_reset_form.html`):
/// it names a credential, and with the credential words taken out, every word left is on
/// `DOC_WORDS` or `LAYOUT_WORDS` and one is on `DOC_WORDS` (`admin-passwords-page.html` names
/// whose they are).
/// A `txt` file is a mail template (`password_reset_subject.txt`) only with a singular credential
/// word, a subject or body word and one more word saying what the mail does.
fn about_credentials(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    // `passwordless` is a way to log in; `secrets-less` is no word.
    let words = credential_words(&stem.replace("wordless", "word login"), TOKEN_WORDS);
    let doc_word = |word: &String| DOC_WORDS.contains(&word.as_str());
    let mail = |word: &String| matches!(word.as_str(), "subject" | "email");
    let text = extension(name) == "txt";
    DOC_EXTENSIONS.contains(&extension(name))
        && words.credentials > 0
        && words.rest.iter().any(doc_word)
        && words.rest.iter().all(|word| doc_word(word) || LAYOUT_WORDS.contains(&word.as_str()))
        && (!text || (!words.plural && words.rest.iter().any(mail) && words.rest.iter().any(|word| !mail(word))))
}

/// `.env`, `.env-prod`, `prod.env`, and any `env` part with more after it (`.env.local`,
/// `app.env.local`).
fn env_file(name: &str) -> bool {
    [".env-", ".env_"].iter().any(|prefix| name.starts_with(prefix)) || name.split('.').skip(1).any(|part| part == "env")
}

/// The name without one template ending: `server.key.example` → `server.key`.
fn without_template(name: &str) -> &str {
    TEMPLATE_ENDINGS.iter().find_map(|ending| name.strip_suffix(ending).and_then(|rest| rest.strip_suffix('.'))).unwrap_or(name)
}

/// Entry step 4: names that are credentials whatever their extension.
fn named_credential(name: &str) -> bool {
    let (stem, extension) = name.split_once('.').unwrap_or((name, ""));
    NAMES.contains(&name)
        // A template ending never makes a key a template (`server.key.example`).
        || KEY_EXTENSIONS.iter().any(|extension| without_template(name).ends_with(extension))
        // `deploy_key`, `master_key.txt`, `key.json`, `sa-key.json`; not `sort_key.rs`.
        || ((stem == "key" || stem.ends_with("_key") || stem.ends_with("-key")) && matches!(extension, "" | "txt" | "json"))
        // A WireGuard interface (`wg0.conf`) holds its private key.
        || (stem.strip_prefix("wg").is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())) && extension == "conf")
        // `secrets.py`, `prod.secret.exs`; not a `secret.js` module.
        || (name.split('.').enumerate().any(|(at, part)| part == "secrets" || (at > 0 && part == "secret")) && VALUE_CODE.contains(&self::extension(name)))
}

/// `.eslintrc`, `.secretlintrc.json`, `.gitleaksignore`: tool settings, not secrets.
fn config_dot_file(name: &str) -> bool {
    let stem = name.split('.').find(|part| !part.is_empty()).unwrap_or("");
    name.starts_with('.') && (stem.ends_with("rc") || stem.ends_with("ignore"))
}

/// An Angular component's template (`password.component.html`) is the component's code.
fn component_template(name: &str) -> bool {
    MARKUP.contains(&extension(name)) && name.split('.').any(|part| part == "component")
}

/// A doc or page named for production alone, once credential words are taken out
/// (`prod-passwords.md`, `secrets/prod.md`).
fn production_alone(stem: &str) -> bool {
    matches!(credential_words(stem, TOKEN_WORDS).rest.as_slice(), [word] if PRODUCTION.contains(&word.as_str()))
}

/// The plain rule for one entry: the entry steps in the module doc, in order. `design`: the
/// entry is a file under a folder with a design word, so token names are design tokens.
fn credential_name(name: &str, directory: bool, design: bool) -> bool {
    // 1. Login dot-names, files or folders.
    if CREDENTIAL_DOT_NAMES.contains(&name) {
        return true;
    }
    // 2. A folder named like an env file (`my.env.tools`) is a folder, and one named for
    // credentials (`my-secrets`) is judged by the files in it, so a project named
    // `keychain-swift` stays a project.
    if directory {
        return false;
    }
    let code = source_file(name) || config_dot_file(name) || component_template(name);
    // 3. A module named for an environment (`app.env.ts`) is code; `.env.js` is still an env
    // file, but a `.env.d.ts` declaration holds types.
    if env_file(name) && (!code || (name.starts_with(".env") && !name.ends_with(".d.ts"))) {
        return true;
    }
    // 4. Key names and named stores.
    if (prefixed(name) && !code) || (named_credential(name) && !about_credentials(name)) {
        return true;
    }
    // 5. A placeholder copy (`secrets.example.yaml`) is a template, like `.env.example`.
    if name.split('.').skip(1).any(|part| TEMPLATE_ENDINGS.contains(&part)) {
        return false;
    }
    let (stem, extension) = name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()).unwrap_or((name, ""));
    // 6. Docs: one credential word and production alone.
    if DOCS.contains(&extension) {
        return credential_words(stem, TOKEN_WORDS).credentials == 1 && production_alone(stem);
    }
    // 7. `secrets.sh` exports the values; `credential-helper.sh` does something with them.
    if SHELL_EXTENSIONS.contains(&extension) {
        return owned_credentials(stem, &[]);
    }
    // 8. Token files and credential words.
    let token = token_name(name) && !design && TOKEN_EXTENSIONS.contains(&extension);
    (token || (mentions_credentials(name) && !code)) && !about_credentials(name)
}

/// Code languages beyond those the outline knows, for the source-file exemption. Not `sql`:
/// `passwords.sql` is more often data than code.
const MORE_CODE_EXTENSIONS: &[&str] = &["cs", "dart", "scala", "ex", "exs", "lua", "graphql", "proto", "css", "scss", "astro", "tf", "gradle", "vue", "svelte"];

/// Whether an extension (lowercase, no dot) is a programming language's.
pub(crate) fn is_code_extension(extension: &str) -> bool {
    crate::explore::outlined_extension(extension) || MORE_CODE_EXTENSIONS.contains(&extension)
}

/// A file named after what it handles (`secret_store.rs`) is code, not a secret, in any language
/// the outline knows and a few more; never a shell script.
fn source_file(name: &str) -> bool {
    let extension = extension(name);
    is_code_extension(extension) && !SHELL_EXTENSIONS.contains(&extension)
}

/// Whether one directory entry is refused, judged as named and as each backup it may be a copy
/// of (`server.key.bak`, `.pgpass~`, `private.pem.txt`). The strict rule adds to the plain one.
/// `name` may be in any case.
pub(crate) fn refused_entry(name: &str, directory: bool, strict: bool) -> bool {
    judged_entry(name, directory, strict, false)
}

fn judged_entry(name: &str, directory: bool, strict: bool, design: bool) -> bool {
    let name = name.to_lowercase();
    !env_template(&name) && copied_names(&name).any(|name| credential_name(name, directory, design) || (strict && strict_name(name)))
}

/// A folder with a design word (`design`, `src/theme`): its token files are design tokens.
fn design_folder(name: &str) -> bool {
    name.split(|c: char| !c.is_ascii_alphanumeric()).any(|word| DESIGN_WORDS.contains(&word))
}

/// The name, then each name it may be a copy of: `a.key.bak` → `a.key`, `#a.key#` → `a.key`,
/// `a.key.1` → `a.key`. A template's copy (`.env.example.bak`) needs no exemption: it is an
/// env name either way. A template about credentials is no copy (`password_reset_subject.txt`).
fn copied_names(name: &str) -> impl Iterator<Item = &str> + '_ {
    std::iter::successors(Some(name), |&name: &&str| if about_credentials(name) { None } else { copy_of(name) })
}

fn copy_of(name: &str) -> Option<&str> {
    // Rotated, numbered and dated copies: `.1`, `.20240101`, `.2024-01-01`, `~1`, `.~1~`, `.backup1`.
    let numbered = name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '-');
    let numbered = (numbered.len() < name.len()).then(|| numbered.strip_suffix('.').or((numbered.ends_with('~') || numbered.ends_with("backup")).then_some(numbered))).flatten();
    let autosave = name.strip_prefix('#').and_then(|name| name.strip_suffix('#'));
    // Browser and file-manager copies: `id_rsa (1)`, `id_rsa (copy)`, `id_rsa (old)`.
    let copy = name.strip_suffix(')').and_then(|name| name.rsplit_once(" (")).map(|(name, _)| name);
    BACKUP_SUFFIXES.iter().find_map(|suffix| name.strip_suffix(suffix)).or(numbered).or(autosave).or(copy)
}

/// An Android string resource (`res/values*/x.xml`): it holds the values its name is about.
fn android_values(parts: &[&str]) -> bool {
    let [.., res, values, name] = parts else { return false };
    res.eq_ignore_ascii_case("res") && values.to_lowercase().starts_with("values") && name.to_lowercase().ends_with(".xml")
}

/// Whether `parts` from `at` on start with the slash path `spec`.
fn path_at(parts: &[String], at: usize, spec: &str) -> bool {
    spec.split('/').enumerate().all(|(step, part)| parts.get(at + step).is_some_and(|name| name == part))
}

/// Whether a project-relative path is refused: the path steps in the module doc, in order.
pub(crate) fn secret_path(relative: &str, strict: bool) -> bool {
    let parts: Vec<&str> = relative.split(['/', '\\']).filter(|part| !matches!(*part, "" | "." | "..")).collect();
    let last = parts.len().saturating_sub(1);
    let lower: Vec<String> = parts.iter().map(|part| part.to_lowercase()).collect();
    let Some(name) = lower.last() else { return false };
    let (stem, extension) = name.rsplit_once('.').unwrap_or((name, ""));
    // 1. GitHub runs only the files directly in `workflows`; they read secrets by name.
    let workflow = lower.len() == 3 && path_at(&lower, 0, ".github/workflows") && matches!(extension, "yml" | "yaml");
    if workflow && !strict && !prefixed(name) {
        return false;
    }
    // 2. Any refused entry; token names under a design folder are design tokens.
    let design = lower[..last].iter().any(|part| design_folder(part));
    if parts.iter().enumerate().any(|(at, part)| judged_entry(part, at != last, strict, design && at == last)) {
        return true;
    }
    // 3. Strict mode makes no page exemption, so a resource file is judged by it.
    if android_values(&parts) && refused_entry(parts[last], false, true) {
        return true;
    }
    // 4. Tool logins; backups count on both sides (`.docker/config.json.bak`, `.docker.bak/config.json`).
    if lower.len() > 2 && LOGIN_FOLDERS.iter().any(|folder| path_at(&lower, 0, folder)) {
        return true;
    }
    let pair = |folder: &str, file: &str| copied_names(&lower[last - 1]).any(|name| name == folder) && copied_names(&lower[last]).any(|name| name == file);
    if last > 0 && FOLDER_FILES.iter().any(|&(folder, file)| pair(folder, file)) {
        return true;
    }
    let folders = &lower[..last];
    let code = source_file(name) || component_template(name);
    // 5. The folder names the credential: a doc or page there is about it unless named for
    // production alone; Strict mode has refused the folder itself.
    let page = (DOCS.contains(&extension) || MARKUP.contains(&extension)) && !production_alone(stem);
    let ui_text = UI_TEXT.contains(&name.split('.').next().unwrap_or(name));
    let image = !strict && IMAGES.contains(&extension);
    if folders.iter().any(|part| credential_folder(part)) && !code && !page && !ui_text && !image {
        return true;
    }
    // 6. Token folders: only files named for whose they are.
    folders.iter().any(|part| token_folder(part)) && !code && only_owners(&credential_words(stem, &[]).rest)
}

/// The home folder: `HOME`, `USERPROFILE`, else the system's record (a service started without
/// `HOME`), so the home rules never go unchecked for want of a variable.
pub(crate) fn home_folder() -> Option<PathBuf> {
    home_with(|key| std::env::var_os(key))
}

fn home_with(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    let found = ["HOME", "USERPROFILE"].iter().find_map(|key| var(key).filter(|home| !home.is_empty())).map(PathBuf::from);
    // ponytail: std reads an empty `HOME` as the home; the passwd entry would need libc.
    found.or_else(|| std::env::home_dir().filter(|home| !home.as_os_str().is_empty()))
}

/// A path's folder names, in lowercase when `fold`, without macOS's aliases: `/private/var/x`
/// is `/var/x`, and the data-volume firmlink's `/System/Volumes/Data/Users/me` is `/Users/me`.
fn path_parts(path: &Path, fold: bool) -> Vec<String> {
    let parts: Vec<String> = path.components().filter_map(|part| if let Component::Normal(name) = part { Some(name.to_string_lossy().into_owned()) } else { None }).collect();
    let is = |at: usize, name: &str| parts.get(at).is_some_and(|part| part.eq_ignore_ascii_case(name));
    let skip = if DATA_VOLUME.iter().enumerate().all(|(at, name)| is(at, name)) { DATA_VOLUME.len() } else { 0 };
    let skip = if is(skip, "private") { skip + 1 } else { skip };
    parts[skip..].iter().map(|part| if fold { part.to_lowercase() } else { part.clone() }).collect()
}

/// Folders that hold whole disks: refused down to the disk itself (`/Volumes/<disk>`).
const MOUNT_ROOTS: &[(&str, usize)] = &[("volumes", 2), ("mnt", 2), ("media", 3), ("run", 4)];
/// Windows system folders at the top of a disk (this one or a mounted one), refused with
/// everything in them.
const WINDOWS_ROOTS: &[&str] = &["windows", "programdata"];

/// Whether this system's paths are case-blind (macOS and Windows), so `/Users/me` is `/users/Me`.
const CASE_BLIND: bool = cfg!(any(target_os = "macos", windows));
/// Folders that hold every user's home.
const HOMES: &[&str] = &["users", "home"];
/// macOS's firmlink to the data volume: `/System/Volumes/Data/Users/me` is `/Users/me`.
const DATA_VOLUME: [&str; 3] = ["system", "volumes", "data"];

/// Why a root is refused, completing "this folder is …".
pub(crate) const TOO_BROAD: &str = "too broad to explore";
pub(crate) const APP_DATA: &str = "inside an app-data folder";
pub(crate) const CREDENTIALS: &str = "inside a folder that may hold credentials";

/// A folder no tool should walk as if it were a project: the home folder or any ancestor of it,
/// another user's home, a system root, a disk, an app-data folder of a home, or a folder that
/// holds credentials (by the call's own rule). `root` and `home` are absolute. The project's
/// own name never refuses it: files in it are judged as the walk meets them.
pub(crate) fn root_refusal(root: &Path, home: Option<&Path>, strict: bool) -> Option<&'static str> {
    refusal(root, home, strict, CASE_BLIND)
}

/// `root_refusal`, with this home told apart from others in lowercase when `fold`; every other
/// rule compares names in lowercase.
fn refusal(root: &Path, home: Option<&Path>, strict: bool, fold: bool) -> Option<&'static str> {
    let parts = &path_parts(root, true);
    let first = parts.first().map_or("", String::as_str);
    // `/System` and `/System/Volumes` reach every home through the data-volume firmlink.
    let system_volume = first == "system" && parts.len() <= 2;
    // `/tmp` (`/private/tmp` on macOS) is every user's scratch folder, not a project.
    let shared = parts.len() == 1 && (first == "tmp" || SYSTEM_ROOTS.contains(&first));
    let system = parts.is_empty() || shared || system_volume || matches!(first, "proc" | "sys" | "dev");
    // Windows folders at the top of this disk or of a mounted one (WSL's `/mnt/c/Windows`).
    let windows = |at: usize| parts.get(at).is_some_and(|part| WINDOWS_ROOTS.contains(&part.as_str()));
    let mount = MOUNT_ROOTS.iter().find(|(mount, _)| first == *mount);
    let disk = mount.is_some_and(|&(_, depth)| parts.len() <= depth || windows(depth));
    if system || windows(0) || disk {
        return Some(TOO_BROAD);
    }
    // `/var/root` (also `/private/var/root`) is root's home on macOS.
    if parts.len() > 1 && parts[0] == "var" && parts[1] == "root" {
        return Some(TOO_BROAD);
    }
    let named = path_parts(root, fold);
    if let Some(home) = home.map(|home| path_parts(home, fold)).filter(|home| !home.is_empty()) {
        if home.starts_with(&named) {
            return Some(TOO_BROAD);
        }
        // Inside this home, folder names never make another home.
        if named.starts_with(&home) {
            return below_home(&parts[home.len()..], strict);
        }
    }
    match home_at(parts) {
        // Another user's home on this disk, or every home when this one is unknown.
        Some((0, _)) => Some(TOO_BROAD),
        // A home on another disk (`/Volumes/Old/Users/me`, WSL's `/mnt/c/Users/me`): its
        // projects are explored like this home's.
        Some((_, end)) if parts.len() <= end => Some(TOO_BROAD),
        Some((_, end)) => in_path(&parts[..end], strict).or(below_home(&parts[end..], strict)),
        None => in_path(parts, strict),
    }
}

/// Where a home is in `parts`: whether it is this disk's own (`0`, also for `/var/home/me` and
/// `/root`), and the end of the home, or of the folder of homes when nothing follows it.
/// A folder of homes is the top of a disk's tree: `/Users`, `/home`, `/var/home`, or the same
/// on a mounted disk (`/Volumes/<disk>/Users`, `/mnt/c/Users`); a `home` or `users` folder
/// anywhere else is a project's.
fn home_at(parts: &[String]) -> Option<(usize, usize)> {
    let first = parts.first()?.as_str();
    if first == "root" {
        return Some((0, 1));
    }
    let at = if first == "var" { 1 } else { MOUNT_ROOTS.iter().find(|(mount, _)| *mount == first).map_or(0, |(_, depth)| *depth) };
    let homes = parts.get(at).is_some_and(|part| HOMES.contains(&part.as_str())) && parts.get(at + 1).is_none_or(|user| user != "shared");
    homes.then_some((if first == "var" { 0 } else { at }, at + 2))
}

/// A root below a home: its app-data folders and every dot folder right under it hold tools'
/// logins, unless on `HOME_ALLOWED`.
fn below_home(below: &[String], strict: bool) -> Option<&'static str> {
    let first = below.first().map_or("", String::as_str);
    let allowed = HOME_ALLOWED.iter().any(|allowed| path_at(below, 0, allowed));
    if (first.starts_with('.') || HOME_PRIVATE.contains(&first)) && !allowed {
        return Some(APP_DATA);
    }
    in_path(below, strict)
}

/// Folders on the way to a root, each judged as a folder: login folders (`.ssh`, `.git`,
/// `.config/gh`), and `secrets`-style folders above it, whose files are taken for credentials.
/// Plan mode also refuses every unknown dot folder but agent apps' worktree folders.
fn in_path(parts: &[String], strict: bool) -> Option<&'static str> {
    let last = parts.len().saturating_sub(1);
    if (0..parts.len()).any(|at| LOGIN_FOLDERS.iter().any(|folder| path_at(parts, at, folder))) {
        return Some(APP_DATA);
    }
    let worktrees = |at: usize| WORKTREE_DOTS.contains(&parts[at].as_str()) && parts.get(at + 1).is_some_and(|next| next == "worktrees");
    let refused = parts.iter().enumerate().any(|(at, part)| {
        refused_entry(part, true, false) || (strict && unknown_dot_name(part) && !worktrees(at)) || (at < last && credential_folder(part))
    });
    refused.then_some(CREDENTIALS)
}

#[cfg(test)]
#[path = "secret_paths_tests.rs"]
mod tests;
