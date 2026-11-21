---
description: Install the opencode-footprint CO2 tracker plugin
---
Install the opencode-footprint plugin into this project from this repository's current state. Follow these steps exactly, from the project root:

1. Download the repository into a temporary directory. The snippet only prints errors (it never exits the shell). If it prints a line starting with `ERROR`, stop and report that line to the user:
   ```sh
   SRC=""
   SRC=$(mktemp -d) &&
   curl -fsSL "https://github.com/scesbron/opencode-footprint/archive/refs/heads/main.tar.gz" | tar -xz -C "$SRC" --strip-components=1 &&
   test -f "$SRC/.opencode/plugins/co2-footprint/index.ts" &&
   echo "Installing opencode-footprint from scesbron/opencode-footprint main into $SRC" ||
   echo "ERROR: could not download or unpack the repository" >&2
   ```
2. Copy the plugin files from the archive into this project. If an older V1 install is present (top-level `.opencode/plugins/co2-tracker.ts`, `.opencode/plugins/co2-sidebar.tsx`, `.opencode/tui.json`, `.opencode/plugins/lib/`), remove those files first:
   ```sh
   mkdir -p .opencode/plugins .opencode/commands
   rm -f .opencode/plugins/co2-tracker.ts .opencode/plugins/co2-sidebar.tsx .opencode/tui.json
   rm -rf .opencode/plugins/lib
   cp -R "$SRC/.opencode/plugins/co2-footprint" .opencode/plugins/
   cp "$SRC/.opencode/commands/co2.md" .opencode/commands/co2.md
   ```
3. Merge the `dependencies` object of `$SRC/.opencode/package.json` into `.opencode/package.json` (create the file with just that `dependencies` object if it doesn't exist). Use the repository's exact versions. Do not copy its `devDependencies` or `scripts`. If `@opencode-ai/plugin` is still present from an older install, remove it.
4. Run `bun install` inside `.opencode/`.
5. Delete the temporary directory (`rm -rf "$SRC"`), then confirm the installation by listing the installed files. Remind the user that the plugin needs OpenCode 2.0 or later (tested with 2.3.1) and that no `tui.json` registration is needed.
