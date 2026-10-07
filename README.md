# Kernel Workbench

A Visual Studio-style workflow for Linux kernel development in VS Code and
VSCodium:

- configure, build, run and debug the kernel in QEMU;
- prepare, check, send and apply patch series;
- find where code came from with blame, file history and bisect.

Install the extension and open a kernel source tree. Three tabs appear in the
activity bar:

| Tab | Views | For |
|---|---|---|
| **Kernel** (chip icon) | Kernel | Configure · Build · Run · Debug |
| **Kernel Git** (branch icon) | Series · Apply · Bisect | Patch series, applying from lore, bisecting |
| **History** (clock icon) | File History · Blame | Where code came from |

KUnit tests appear in VS Code's own **Testing** view.

Nothing is written into `.vscode/`. There is no `tasks.json`, no
`launch.json`, and no project file. Options are VS Code settings
(`kernelDev.*`), saved at user level, so every kernel tree uses them. A
workspace value overrides them if you add one.

The interface follows the [VS Code UX guidelines](https://code.visualstudio.com/api/ux-guidelines/overview):

- every view is a native tree view, and empty views show welcome content;
- actions are in each view's toolbar and its **…** menu;
- the editor gets a single **Kernel Workbench** menu, shown only on kernel
  source files (C, assembly, Kconfig, Makefiles, devicetree).

---

## Kernel tab

The **Kernel** view has three groups. Each item shows its current value and
has an edit action (pencil icon) that opens a quick pick or an input box.

- **Target:** Architecture (x86_64, arm64, riscv64), Build (Debug or Release)
  and Base config (`defconfig`, the arch's `*_defconfig` files, `tinyconfig`,
  or an existing `.config`).
- **Status:** when the build was configured and built, whether the VM is
  running, which tools are missing (with an install action), and the step
  that's running.
- **Options:** toolchain (GCC or LLVM), `CROSS_COMPILE`, ccache, extra make
  arguments, config fragments and options, what happens to the terminal after
  a step, boot mode, initramfs, sharing the build directory with the guest,
  kernel command line, QEMU arguments, memory and CPUs.

The view's toolbar has **Configure**, **Build**, **Run** and **Debug**, or
**Stop** while a VM runs. Its **…** menu has menuconfig, nconfig, Clean,
Rebuild, Full Clean (mrproper), Build Modules, DT Check, Check Required Tools
and Open Settings.

| Step | Key | What it does |
|---|---|---|
| **Configure** | | Applies, in order: the base config, `configure.fragments`, the run-mode options, the Debug or Release options, then `configure.options`. Then it runs `make olddefconfig`. The make arguments (`O=`, `ARCH=`, toolchain, ccache, `make.args`) are recorded in the build directory. Requested options that Kconfig dropped are listed. |
| **Build** | F7 | Runs `make` with exactly the recorded arguments (configuring first if needed), with errors in Problems, and refreshes `compile_commands.json` for clangd. |
| **Run** | Ctrl+F5 | Runs an incremental build, then boots the selected variant in QEMU, with your initramfs if one is set for the arch. |
| **Debug** | F5 | Runs an incremental build, boots QEMU halted, runs to `start_kernel` and attaches gdb. Breakpoints work, including in initcalls, and the `lx-*` gdb commands are available. |

- **Debug / Release** build into separate directories,
  `build/<arch>/debug` and `build/<arch>/release`, like Visual Studio's
  `x64\Debug`.
- **Argument changes** take effect at the next Configure, as in CMake.
- **Editor menu:** the editor toolbar's Kernel Workbench menu has the same
  four steps and the target pickers.
- **Right-click → Kernel Workbench:**
  - Compile Current File (**Ctrl+F7**), Preprocess (`.i`) and Show Assembly
    (`.s`);
  - Build This Directory, which builds the directory and links its modules;
  - Show File History, history of selected lines, blame, and Decode Stack
    Trace.

### Initramfs

Run and Debug boot the kernel image directly (`-kernel`). An initramfs set
for the arch is passed with `-initrd`:

```jsonc
"kernelDev.run.initramfs": { "x86_64": "/srv/initramfs/x86_64.cpio.gz" }
```

- **None set:** the kernel boots without one. Give it a root filesystem with
  `kernelDev.run.cmdline` (e.g. `root=/dev/vda rw`) and
  `kernelDev.run.qemuArgs` (e.g. `-drive file=rootfs.img,if=virtio,format=raw`).
- **Set but missing:** that's an error, not a silent boot without it.
- **virtme mode:** with `"kernelDev.run.mode": "virtme"`, virtme-ng boots the
  host's root filesystem instead.

### Modules without rebuilding the initramfs

With **Share build directory with the guest** on
(`kernelDev.run.shareBuildDir`):

- **QEMU:** gets the build directory as a read-only 9p share.
- **Configure:** enables the 9p and virtio options.
- **Run:** prints the guest command:

```sh
mkdir -p /mnt/kbuild && mount -t 9p -o trans=virtio,version=9p2000.L kbuild /mnt/kbuild
insmod /mnt/kbuild/drivers/.../foo.ko
```

### Crashes

The VM's serial console is also logged to
`<build dir>/kernel-dev/console.log`. The terminal and the Ctrl-A X monitor
keys are unchanged.

- **Detection:** when an Oops, BUG, WARNING, panic or general protection
  fault appears, a notification names it.
- **Decoding:** *Show Decoded Trace* runs `scripts/decode_stacktrace.sh`
  against the build's `vmlinux`.
- **Result:** a tab where every `file:line` is a link, and the reliable
  frames in Problems.
- **Pasted traces:** *Decode Stack Trace* does the same for a trace you select
  or copy.

### Devicetree (arm64, riscv64)

*DT Check: Changed Files* and *DT Check: All dtbs* check the affected boards
(`CHECK_DTBS=y`, a changed `.dtsi` selects every board including it), lint and
check changed binding schemas, or run a full `dtbs_check`. Results go to
Problems at the node's line. This needs `dtschema` (`pip install dtschema`)
and `yamllint`.

### clangd

After each build, the build's `compile_commands.json` is written to the root
of the tree (the kernel's `.gitignore` already ignores it), and clangd is
restarted.

- **GCC builds:** the flags clang rejects and the plain `-Werror` are stripped,
  and the clang target is set.
- **Selection:** switching arch or variant re-points clangd at that build.
- **Nothing else written:** no `.clangd` or settings. Turn it off with
  `kernelDev.clangd.updateCompileCommands`.

### How Debug works

1. QEMU starts with `-S` and a gdbstub. At reset the MMU is off, and on x86
   the kernel isn't decompressed yet, so an IDE's software breakpoints would
   fail or be overwritten.
2. A short-lived gdb runs the guest to `start_kernel` on a hardware breakpoint
   and disconnects, leaving QEMU paused there.
3. The IDE debugger attaches and inserts your breakpoints. The front end is
   cpptools in VS Code or Native Debug (`webfreak.debug`) in VSCodium.

---

## Kernel Git tab

### Series: check, format, generate, send

A **series** is the commits of the current branch on top of a base.

- **Base:** the one you pick, else the branch's upstream, else
  `kernelDev.patches.base` (`origin/master`). If none exists, a welcome view
  asks for one.
- **Commits:** each shows its checkpatch result as its icon. Hovering shows
  the commit-message findings, and the inline action opens checkpatch's
  report.

**Check Series** (toolbar) does:

- **checkpatch** on every commit, plus `--strict` and an ignore list when set
  in **Check options**.
- **W=1** on every `.c` file the series touches, using the Kernel tab's build.
  This works even for files disabled in `.config`.
- **sparse** (`C=2`) and **Coccinelle** (`coccicheck MODE=report`), when set
  in Check options. If Kbuild skips sparse because it's missing or too old,
  that's reported rather than looking clean.
- **DT checks** when the series touches devicetree files.

Findings go to Problems on the right line of the working tree: findings from
earlier commits are mapped through the later changes.

The **…** menu also has Check Working Changes and Format Changed Lines
(`git clang-format` against the base).

**Patches** group:

- **Subject prefix** (`PATCH`, `PATCH net-next`, `RFC PATCH`, …).
- **Cover letter:** stored as the git branch description, which
  `git format-patch` reads, so it survives regenerating.
- **To / Cc:** *Fill Recipients from get_maintainer.pl* puts maintainers and
  reviewers in To and lists in Cc. *Edit Recipients* opens them in a tab.
- **Generate Patches:** `git format-patch -v N --cover-letter --base=… --to/--cc
  … -o patches/<branch>/v<N>`. If checkpatch reports **errors**, it lists them
  and continues only on *Generate Anyway*.
- **Send:**
  - *Send Patches: Dry Run* (`git send-email --dry-run`) lists every mail and
    recipient.
  - *Send Patches…* is offered only after a successful dry run of exactly
    these files, and asks once.
  - Configure SMTP yourself (`git config --global sendemail.smtpServer …`).

### Apply: series from lore

1. *Fetch Series from lore…* takes a lore link or Message-ID. `b4 am` takes
   the latest version, puts the patches in order and collects
   Reviewed-by/Acked-by/Tested-by.
2. The view shows the series, its base and the trailers before anything is
   applied. *Apply mbox or Patch Files…* works with local files.
3. *Apply to Current Branch* or *Apply on New Branch…* (at the series'
   base-commit) runs `git am -3`.
4. If `git am` stops, the view shows the patch and the conflicted files.
   *Continue* (refused while conflict markers remain), *Skip* and *Abort* are
   in the toolbar.

### Bisect

- **Manual:** *Start Bisect…* asks for a bad and a good commit. Each step
  shows the commit under test. Build and Run are in the **…** menu, and
  **Good / Bad / Skip** in the toolbar.
- **Automatic:** *Bisect Automatically with a Test Script…* runs
  `git bisect run`. Each step builds the kernel first; a build failure skips
  the commit.
- **Result:** the first bad commit is shown, opens in a tab, and has *Copy
  Fixes: Line*.

---

## History tab

### File History

- **List:** every commit that touched the open file, following renames, 200
  at a time with *Load more*.
- **Filter:** by commit message or author, across the file's old names too.
- **Open a commit:** clicking one opens it as a read-only editor tab. The tab's
  toolbar switches between the whole commit and this file only.
- **Right-click a commit:** copy its hash or `Fixes:` line, open the file at
  that commit, compare with the previous version, or open on lore.
- **Selected lines:** *Show History of Selected Lines* runs `git log -L`.

### Blame

- **Annotations:** *Toggle Blame Annotations* shows hash, date and author
  before each line. Unsaved edits stay aligned.
- **Click the hash** to open that commit. A commit too large for an editor tab
  (the 2.6.12 import) opens as just this file's part of it.
- **Blame view:** follows the cursor. It shows the commit that last changed
  the line and every earlier commit that changed it; the bottom one introduced
  the line.
- **Blame Before This Commit:** reopens the file as of the parent, at the same
  line.

---

## KUnit (Testing view)

- **What runs:** `tools/testing/kunit/kunit.py run` for the selected arch and
  toolchain, in its own build directory (`build/kunit/<arch>`).
- **Tests:** suites and cases appear after the first run. A failure links to
  its `EXPECTATION FAILED at file:line`.
- **This directory:** *Run KUnit Tests for This Directory* (explorer) uses the
  nearest `.kunitconfig`.

---

## Settings (main ones)

| Setting | Default | |
|---|---|---|
| `kernelDev.toolchain` | `gcc` | `gcc` or `llvm` (`LLVM=1`) |
| `kernelDev.crossCompile` | per-arch GNU triples | e.g. `{ "arm64": "aarch64-none-linux-gnu-" }` |
| `kernelDev.configure.defconfig` | `defconfig` | make target(s) or a `.config` path |
| `kernelDev.configure.fragments` / `options` | `[]` / `{}` | e.g. `{ "KASAN": "y" }` |
| `kernelDev.configure.debugOptions` / `releaseOptions` | DWARF + `GDB_SCRIPTS` / `DEBUG_INFO_NONE` | |
| `kernelDev.make.args` / `jobs` / `ccache` | `[]` / all CPUs / `false` | |
| `kernelDev.buildDirectory` | `build/${arch}/${variant}` | |
| `kernelDev.terminal.afterTask` | `waitForKey` | or `close` |
| `kernelDev.run.initramfs` | `{}` | per arch |
| `kernelDev.run.shareBuildDir` | `false` | 9p share for `insmod` |
| `kernelDev.run.memory` / `smp` / `kvm` / `cmdline` / `qemuArgs` | `2G` / `2` / `auto` / `""` / `[]` | |
| `kernelDev.debug.debugger` / `breakAt` / `stopOnEntry` | `auto` / `start_kernel` / `false` | |
| `kernelDev.patches.base` / `outputDirectory` | `origin/master` / `patches/${branch}/v${version}` | |
| `kernelDev.checkpatch.strict` / `ignore` | `false` / `[]` | |
| `kernelDev.check.sparse` / `coccinelle` | `false` / `false` | |
| `kernelDev.apply.addLink` / `addSignoff` | `true` / `false` | |
| `kernelDev.blame.ignoreWhitespace` / `detectMoves` | `true` / `false` | |
| `kernelDev.kunit.buildDirectory` / `kunitconfig` | `build/kunit/${arch}` / `""` | |

*Kernel: Open Settings* shows all of them.

## Requirements

Host packages (Debian/Ubuntu):

```sh
sudo apt install build-essential flex bison bc libelf-dev libssl-dev \
                 qemu-system-x86 qemu-system-arm qemu-system-misc gdb gdb-multiarch b4
sudo apt install gcc-aarch64-linux-gnu gcc-riscv64-linux-gnu   # cross gcc
sudo apt install clang lld llvm                                 # toolchain=llvm
sudo apt install git-email clang-format ccache                  # sending, formatting, ccache
sudo apt install sparse coccinelle ocaml-nox                    # optional checks
pip install dtschema                                            # devicetree checks
```

When the extension loads, and whenever you change the arch, toolchain or
options, it checks for what Configure, Build, Run, Debug and the enabled
checks need.

- **Kernel view:** missing tools are listed under Status → Tools.
- **Notification:** offers *Run Install Command*, *Copy Command* and *Don't
  Show Again*.

---

## Development

The extension is plain JavaScript checked by TypeScript (`// @ts-check`);
there's no build step.

```
extension.js        activation: wires the parts together, registers commands
src/settings.js     selection, kernelDev.* settings, recorded Configure arguments
src/kbuild.js       Configure / Build / Clean / Full clean / single files / modules
src/runner.js       QEMU Run and Debug, gdb hand-off (scripts/run-to.py)
src/kernelView.js   Kernel view and option editing
src/series.js       Series view and checks; patches.js (format-patch), send.js (send-email)
src/checkpatch.js   checkpatch runs and Problems
src/apply.js        Apply view (b4 am, git am)
src/bisect.js       Bisect view (git bisect)
src/history.js      File History view; commits.js: read-only commit tabs
src/blame.js        blame annotations (inlay hints) and Blame view
src/oops.js, dt.js, kunit.js, clangd.js, tools.js, ui.js, tasks.js, git.js, arch.js
```

### Tests

```sh
scripts/test.sh                 # type check, unit tests, integration tests in VS Code, coverage
scripts/test.sh unit            # unit tests only
KWB_E2E=1 scripts/test.sh       # also build, boot, crash and debug a real kernel (minutes)
```

`scripts/test.sh` runs everything in a container (`test/docker/Dockerfile`),
so no Node.js is needed on the host.

- **Unit tests** (`test/unit`): mocha, with a mock of the VS Code API
  (`test/helpers/vscode.js`) and real git in throwaway repositories. External
  tools (checkpatch.pl, get_maintainer.pl, b4, git send-email, make) are small
  stand-in scripts, so the tests exercise the extension's logic.
- **Integration tests** (`test/integration`): run in a real VS Code
  (`@vscode/test-electron`) on a throwaway clone of a kernel tree
  (`KWB_KERNEL_TREE`, default `../linux-playground`; it is never written to).
  They drive commands, quick picks, tree views, Problems, inlay hints and
  editor tabs, and use the tree's real checkpatch, get_maintainer.pl, git am,
  git send-email `--dry-run` and git bisect.
- **End to end** (`KWB_E2E=1`): configures and builds a defconfig kernel,
  boots it in QEMU with an initramfs, crashes it and checks the decoded trace,
  checks the debugger hand-off at `start_kernel`, runs W=1 with the build, and
  runs KUnit.

### Reports

| File | Contents |
|---|---|
| `coverage/index.html` | Line, branch and function coverage of the unit and integration tests combined |
| `test-results/coverage.md` | The same as a table |
| `test-results/ui-performance.md` | How long each view, action and step took in the integration tests |
| `test-results/unit.txt`, `integration.txt` | Test output |

### Packaging

```sh
npx @vscode/vsce package     # or scripts/package-vsix.sh without Node.js
code --install-extension kernel-workbench-<version>.vsix
```
