{
  description = "AER client packages";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    # Explicit system list rather than eachDefaultSystem: that helper still
    # includes x86_64-darwin, which nixpkgs dropped in 26.11, so evaluating it
    # aborts and takes `nix flake show` and `nix flake check` down with it.
    flake-utils.lib.eachSystem [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ] (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Every workspace member that has a package.json, keyed by its npm
        # package name (used for `pnpm --filter`). Kept in one place so the
        # dep-vendoring derivation and the per-package build derivations agree
        # on exactly what "the workspace" is.
        pnpmWorkspaces = [
          "@adastracomputing/aer-auto-node"
          "@adastracomputing/aer-emit"
          "@adastracomputing/aer-hooks"
          "@adastracomputing/aer-mcp-guard"
          "@adastracomputing/aer-mcp-recorder"
          "@adastracomputing/aer-resource-node"
          "@adastracomputing/aer-verify"
          "@aer-oss/attestation-test-utils"
          "@aer/schemas"
          "@adastracomputing/aer-sdk-ts"
          "@adastracomputing/aer"
        ];

        # Vendors the exact pnpm-lock.yaml graph as a fixed-output derivation
        # (network access happens only here, at eval/fetch time, in a sandbox
        # exempted for FOD hashing) so every build below is fully offline and
        # reproducible. Bump the hash whenever pnpm-lock.yaml changes: set it
        # to lib.fakeHash, run `nix build .#checks.<system>.default`, and copy
        # the "got:" value nix prints back in.
        pnpmDeps = pkgs.fetchPnpmDeps {
          pname = "aer";
          src = self;
          inherit pnpmWorkspaces;
          pnpm = pkgs.pnpm;
          fetcherVersion = 4;
          hash = "sha256-1plVXnG6up1XCwOvvvRsPYTjIZwOganUm87j5TC5AoU=";
        };

        # Common offline build environment shared by every package/check
        # derivation below: real network access is never needed past this
        # point, node_modules is populated entirely from pnpmDeps.
        mkAerDerivation = { name, buildPhaseScript, installPhaseScript, extraInputs ? [ ] }:
          pkgs.stdenvNoCC.mkDerivation {
            inherit name;
            src = self;
            inherit pnpmDeps;
            nativeBuildInputs = [ pkgs.nodejs_24 pkgs.pnpm pkgs.pnpmConfigHook ] ++ extraInputs;
            buildPhase = ''
              runHook preBuild
              export HOME=$TMPDIR
              ${buildPhaseScript}
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              ${installPhaseScript}
              runHook postInstall
            '';
          };

        # One packages.<system>.<name> output per publishable npm package:
        # builds it (topological pnpm -r build so its workspace deps compile
        # first) then `pnpm pack`s the tarball npm would actually publish.
        # Attr name -> { dir = packages/<dir>; npmName = package.json "name" }.
        publishablePackages = {
          aer-auto-node = { dir = "aer-auto-node"; npmName = "@adastracomputing/aer-auto-node"; };
          aer-emit = { dir = "aer-emit"; npmName = "@adastracomputing/aer-emit"; };
          aer-hooks = { dir = "aer-hooks"; npmName = "@adastracomputing/aer-hooks"; };
          aer-mcp-guard = { dir = "aer-mcp-guard"; npmName = "@adastracomputing/aer-mcp-guard"; };
          aer-mcp-recorder = { dir = "aer-mcp-recorder"; npmName = "@adastracomputing/aer-mcp-recorder"; };
          aer-resource-node = { dir = "aer-resource-node"; npmName = "@adastracomputing/aer-resource-node"; };
          aer-verify = { dir = "aer-verify"; npmName = "@adastracomputing/aer-verify"; };
          aer-sdk-ts = { dir = "sdk-ts"; npmName = "@adastracomputing/aer-sdk-ts"; };
        };

        mkPackageTarball = attrName: { dir, npmName }:
          mkAerDerivation {
            name = "${attrName}-tarball";
            buildPhaseScript = ''
              pnpm --filter "${npmName}^..." --filter "${npmName}" build
            '';
            installPhaseScript = ''
              mkdir -p $out
              (cd packages/${dir} && pnpm pack --pack-destination $out)
            '';
          };
        # The CLI as something you can actually run, so a Nix user is not forced
        # through npx. dist/main.js is a single bundled file, so the wrapper only
        # needs node.
        aerCli = mkAerDerivation {
          name = "aer";
          extraInputs = [ pkgs.makeWrapper ];
          buildPhaseScript = ''
            pnpm --filter "@adastracomputing/aer^..." --filter "@adastracomputing/aer" build
          '';
          installPhaseScript = ''
            mkdir -p $out/lib $out/bin
            cp apps/cli/dist/main.js $out/lib/main.js
            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/aer \
              --add-flags $out/lib/main.js
          '';
        };

        # Every published package has zero external runtime dependencies, only
        # workspace siblings, so a plain node_modules tree is enough to run the
        # collector with no npm anywhere. Point NODE_PATH at it.
        nodeModules = mkAerDerivation {
          name = "aer-node-modules";
          buildPhaseScript = ''
            pnpm -r build
          '';
          installPhaseScript = ''
            dest=$out/lib/node_modules/@adastracomputing
            mkdir -p $dest
            ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.mapAttrsToList
              (attr: { dir, npmName }: ''
                mkdir -p $dest/${baseNameOf npmName}
                cp -r packages/${dir}/dist packages/${dir}/package.json $dest/${baseNameOf npmName}/
              '') publishablePackages)}
          '';
        };

        # Runnable wrappers for the package binaries, so Nix is not limited to
        # the CLI. Each script runs in place inside the nodeModules tree, where
        # its workspace siblings resolve; NODE_PATH would not work, since these
        # packages are ESM and Node's ESM resolver ignores it.
        mkNodeBin = { bin, pkgDir, entry }:
          pkgs.runCommand "aer-bin-${bin}" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
            mkdir -p $out/bin
            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/${bin} \
              --add-flags ${nodeModules}/lib/node_modules/@adastracomputing/${pkgDir}/${entry}
          '';

        # One entry per `bin` in a published package.json. Libraries are not
        # listed: there is nothing to run.
        nodeBins = {
          aer-hooks = mkNodeBin { bin = "aer-hooks"; pkgDir = "aer-hooks"; entry = "dist/install-cli.js"; };
          aer-hook = mkNodeBin { bin = "aer-hook"; pkgDir = "aer-hooks"; entry = "dist/cli.js"; };
          aer-mcp-recorder = mkNodeBin { bin = "aer-mcp-recorder"; pkgDir = "aer-mcp-recorder"; entry = "dist/cli.js"; };
        };

        # `meta.description` is what `nix flake show` prints and what
        # `nix flake check` warns about when it is missing.
        appDescriptions = {
          aer = "AER CLI: init, doctor, smoke, verify, import";
          aer-hooks = "Wire AER recording into a coding harness";
          aer-hook = "Per-event hook binary a wired harness invokes";
          aer-mcp-recorder = "Recording MCP proxy for an MCP server command";
        };
        mkApp = bin: drv: {
          type = "app";
          program = "${drv}/bin/${bin}";
          meta.description = appDescriptions.${bin};
        };

        # Every AER command in one installable output. A wired harness invokes
        # a bare `aer-hook` on every tool call, so that binary must be on PATH
        # for good; `nix run` only lends it for one command.
        tools = pkgs.symlinkJoin {
          name = "aer-tools";
          paths = [ aerCli ] ++ pkgs.lib.attrValues nodeBins;
        };

        # The Python SDK is deliberately never published to PyPI, so Nix is how
        # you consume it without a git URL. Same flake, same nixpkgs pin: a
        # second flake would drift from this one.
        sdkPy = pkgs.python3Packages.buildPythonPackage {
          pname = "aer-sdk";
          version = "0.1.0";
          pyproject = true;
          src = ./packages/sdk-py;
          build-system = [ pkgs.python3Packages.hatchling ];
          nativeCheckInputs = [ pkgs.python3Packages.pytestCheckHook ];
          pythonImportsCheck = [ "aer_sdk" ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            pnpm
            python3
            python3Packages.pytest
            python3Packages.build
            git
          ];
        };

        packages = pkgs.lib.mapAttrs mkPackageTarball publishablePackages // {
          aer = aerCli;
          tools = tools;
          node-modules = nodeModules;
          sdk-py = sdkPy;
          default = aerCli;
        };

        apps = {
          default = mkApp "aer" aerCli;
          aer = mkApp "aer" aerCli;
        } // pkgs.lib.mapAttrs mkApp nodeBins;

        # Fallback per the project's own ADR-style rule for this flake: a
        # faithful `packages.<name>` output IS achievable here (pnpm workspace
        # builds are reproducible once deps are vendored via fetchPnpmDeps),
        # so it is provided above. `checks.default` additionally runs the full
        # build+test+typecheck matrix for every workspace member offline, so
        # `nix flake check` is a real correctness gate, not just a smoke test.
        # buildPythonPackage runs the package's pytest suite, so exposing it as a
        # check makes `nix flake check` cover the Python SDK too.
        checks.sdk-py = sdkPy;

        checks.default = mkAerDerivation {
          name = "aer-workspace-checks";
          buildPhaseScript = ''
            pnpm -r build
            pnpm -r typecheck
            pnpm -r test
          '';
          installPhaseScript = ''
            touch $out
          '';
        };
      });
}
