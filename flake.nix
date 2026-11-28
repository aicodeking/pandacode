{
  description = "PandaCode: a lightweight native workspace for coding agents";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in
    {
      packages = forAllSystems (pkgs:
        let
          # Opened at runtime with dlopen (tray icon), so it must be on the library path.
          runtimeLibs = with pkgs; [ libayatana-appindicator ];
        in
        {
          # Remote access (docs/remote-access.md) needs a relay and a GitHub OAuth app, which the
          # release workflow takes from the repository variables of the same names. Both are public
          # values; the defaults are the official ones. Point a fork at its own with
          # `.override { relayUrl = "https://..."; githubClientId = "..."; }`, or "" to turn it off.
          pandacode = pkgs.lib.makeOverridable ({ relayUrl, githubClientId }: pkgs.rustPlatform.buildRustPackage {
            pname = "pandacode";
            inherit version;

            src = pkgs.lib.cleanSourceWith {
              src = ./.;
              filter = path: type:
                let name = baseNameOf path; in
                !(builtins.elem name [ "node_modules" "dist" "target" "website" "relay" "bench" "releases" ".git" ".github" "docs" "README.md" "flake.nix" "flake.lock" ]);
            };

            cargoLock.lockFile = ./src-tauri/Cargo.lock;
            cargoRoot = "src-tauri";
            buildAndTestSubdir = "src-tauri";

            # tauri-build embeds ../dist at compile time; `custom-protocol` makes the app serve it
            # instead of the dev URL (what `tauri build` turns on).
            buildFeatures = [ "tauri/custom-protocol" ];

            # Reads the integrity hashes already in package-lock.json, so there is no separate
            # hash to keep in step with it.
            npmDeps = pkgs.importNpmLock { npmRoot = ./.; };

            nativeBuildInputs = with pkgs; [
              nodejs
              importNpmLock.npmConfigHook
              pkg-config
              cmake
              rustPlatform.bindgenHook
              wrapGAppsHook3
            ];

            buildInputs = with pkgs; [
              webkitgtk_4_1
              gtk3
              libsoup_3
              glib-networking
              openssl
              alsa-lib
              sqlite
              dbus
              librsvg
              xdotool
            ] ++ runtimeLibs;

            env = {
              PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
              # The on-device speech engine's CPU flags, as in release.yml: baseline hardware, not the
              # build host's, so voice input does not hit illegal instructions on older CPUs.
              TRANSCRIBE_CMAKE_ARGS =
                if pkgs.stdenv.hostPlatform.isAarch64
                then "-DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8-a"
                else "-DTRANSCRIBE_X86_CONSERVATIVE=ON -DGGML_SSE42=ON -DGGML_AVX=ON -DGGML_F16C=ON";
              PANDACODE_RELAY_URL = relayUrl;
              PANDACODE_GITHUB_CLIENT_ID = githubClientId;
            };

            # cmake is only for transcribe-cpp's own build; don't let it configure this package.
            dontUseCmakeConfigure = true;

            preBuild = ''
              npm run build
            '';

            # The Rust tests need agent CLIs, a network and a display.
            doCheck = false;

            postInstall = ''
              install -Dm644 src-tauri/icons/128x128.png $out/share/icons/hicolor/128x128/apps/pandacode.png
              install -Dm644 THIRD_PARTY_NOTICES.md $out/share/doc/pandacode/THIRD_PARTY_NOTICES.md
              # Where Tauri looks for bundled resources on Linux: <bin dir>/../lib/<productName>.
              install -Dm644 THIRD_PARTY_NOTICES.md $out/lib/PandaCode/THIRD_PARTY_NOTICES.md
              install -Dm644 LICENSE $out/share/doc/pandacode/LICENSE
              mkdir -p $out/share/applications
              cat > $out/share/applications/pandacode.desktop <<EOF
              [Desktop Entry]
              Type=Application
              Name=PandaCode
              Comment=A lightweight native workspace for coding agents
              Exec=pandacode
              Icon=pandacode
              Categories=Development;
              Terminal=false
              EOF
            '';

            preFixup = ''
              gappsWrapperArgs+=(--prefix LD_LIBRARY_PATH : ${pkgs.lib.makeLibraryPath runtimeLibs})
              # The app runs `git`, `gh` and `xdg-open`; the user's own on PATH win, these are the fallback.
              gappsWrapperArgs+=(--suffix PATH : ${pkgs.lib.makeBinPath [ pkgs.git pkgs.gh pkgs.xdg-utils ]})
            '';

            meta = {
              description = "A lightweight native workspace for coding agents";
              homepage = "https://github.com/aicodeking/pandacode";
              license = {
                shortName = "pandacode";
                fullName = "PandaCode License (MIT-based, requires forks to credit PandaCode)";
                url = "https://github.com/aicodeking/pandacode/blob/main/LICENSE";
                free = true;
              };
              mainProgram = "pandacode";
              platforms = systems;
            };
          }) {
            relayUrl = "https://relay.bambooed.ai";
            githubClientId = "Ov23liQVYbCF1AWuLEBb";
          };

          default = self.packages.${pkgs.stdenv.hostPlatform.system}.pandacode;
        });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.pandacode}/bin/pandacode";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          inputsFrom = [ self.packages.${pkgs.stdenv.hostPlatform.system}.pandacode ];
          packages = with pkgs; [ cargo rustc rustfmt clippy ];
        };
      });
    };
}
