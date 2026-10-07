# Kernel Workbench

Visual Studio-style Linux kernel development in VS Code and VSCodium. Install
the extension and open a kernel source tree. Two tabs appear in the activity
bar:

- **Kernel** (chip icon): Configure · Build · Run · Debug the kernel in QEMU.
- **Kernel Git** (branch icon): turn commits into a checked patch series,
  send it, apply series from lore, and bisect.
- **History** (clock icon): the open file's git history and blame.

KUnit tests appear in VS Code's own **Testing** view.

Nothing is written into `.vscode/`. There is no `tasks.json`, no
`launch.json`, and no project file. Options are VS Code settings
(`kernelDev.*`), saved at user level, so every kernel tree uses them. A
workspace override is respected if you add one.

---

## Kernel tab

The **Kernel panel** has three parts:

- dropdowns for **Architecture**, **Build** (Debug / Release) and **Base
  config**;
- buttons for **Configure / Build / Run / Debug**, plus menuconfig, Clean,
  Rebuild, Full clean (mrproper) and Stop VM, with the state of each step;
- an **Options** section for the toolchain, `CROSS_COMPILE`, ccache, make
  args, config fragments and options, initramfs, kernel cmdline, QEMU args,
  memory, CPUs, and sharing the build directory with the guest.

The same actions are also in an editor toolbar, top right of every source
file. Its target dropdown has checkmarks for the arch and Debug/Release.

| Step | Key | What it does |
|---|---|---|
| **Configure** | | Applies, in order: the base config (default `defconfig`), `configure.fragments`, the run-mode options, the Debug or Release options, then `configure.options`. Then it runs `make olddefconfig`. The make arguments (`O=`, `ARCH=`, toolchain, ccache, `make.args`) are recorded in the build directory. Requested options that Kconfig dropped are listed. |
| **Build** | F7 | Runs `make` with exactly the recorded arguments (configuring first if needed), with errors in Problems, and refreshes `compile_commands.json` for clangd. |
| **Run** | Ctrl+F5 | Runs an incremental build, then boots the selected variant in QEMU, with your initramfs if one is set for the arch. |
| **Debug** | F5 | Runs an incremental build, boots QEMU paused, runs to `start_kernel`, and attaches gdb. Breakpoints work, including in initcalls, and the `lx-*` gdb commands are available. |

- **Debug / Release** build into separate directories, `build/<arch>/debug`
  and `build/<arch>/release`, like Visual Studio's `x64\Debug`. Switching
  rebuilds nothing, and Run and Debug use the selected variant.
- **Argument changes** take effect at the next Configure, as in CMake.
- **Also available:**
  - **Ctrl+F7** compiles the current file.
  - Right-click a `.c` file for *Preprocess (.i)* / *Show Assembly (.s)*.
  - *Build This Directory* (explorer / editor context menu) builds a
    directory and links its modules.
  - *Build Modules* runs `make modules`.

### Initramfs

Run and Debug boot the kernel image directly (`-kernel`). An initramfs set
for the arch is passed with `-initrd`:

```jsonc
"kernelDev.run.initramfs": { "x86_64": "/srv/initramfs/x86_64.cpio.gz" }
```

- **None set:** the kernel boots without one. Give it a root filesystem with
  `kernelDev.run.cmdline` (e.g. `root=/dev/vda rw`) and
  `kernelDev.run.qemuArgs` (e.g. `-drive file=rootfs.img,if=virtio,format=raw`).
- **Set but missing:** an error, not a silent boot without it.
- **virtme mode:** with `"kernelDev.run.mode": "virtme"`, virtme-ng boots the
  host's root filesystem instead.

### Modules without rebuilding the initramfs

Tick **Share the build directory with the guest**
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

- **Detection:** when an Oops, BUG, WARNING, panic, or general protection
  fault appears, a notification names it.
- **Decoding:** *Show Decoded Trace* runs `scripts/decode_stacktrace.sh`
  against the build's `vmlinux` (with the matching `addr2line` for
  LLVM/cross builds).
- **Result:** a tab where every `file:line` is a link, and the reliable
  frames in Problems.
- **Pasted traces:** *Kernel: Decode Stack Trace* does the same for a trace
  you select or copy, e.g. from a bug report.

### Devicetree (arm64, riscv64)

*DT Check: Changed Files* and *DT Check: All dtbs* run `CHECK_DTBS=y` on the
affected boards, `yamllint` + `dt_binding_check` on changed binding schemas,
or a full `dtbs_check`.

- **Affected boards:** a changed `.dtsi` selects every board that includes it.
- **Results:** dtc and schema errors go to Problems at the `.dts` line of the
  node they are about.
- **Needs:** `dtschema` (`pip install dtschema`) and `yamllint`.

### ccache

**Use ccache** records `CC="ccache gcc"` (with the cross prefix) or
`CC="ccache clang"` at Configure, so rebuilds after switching branches,
Debug/Release or bisecting mostly come from the cache.

### clangd

After each build, the build's `compile_commands.json` is written to the root
of the tree (the kernel's `.gitignore` already ignores it) and clangd is
restarted.

- **GCC builds:** the flags clang rejects and the plain `-Werror` are
  stripped, and the clang target is set.
- **Selection:** switching arch or variant re-points clangd at that build.
- **Nothing else written:** no `.clangd` or settings. Turn it off with
  `kernelDev.clangd.updateCompileCommands`.

### How Debug works

1. QEMU starts with `-S` and a gdbstub. At reset the MMU is off, and on x86
   the kernel isn't even decompressed yet, so an IDE's software breakpoints
   would fail or be overwritten.
2. A short-lived gdb runs the guest to `start_kernel` on a hardware breakpoint
   and disconnects, leaving QEMU paused there.
3. The IDE debugger attaches with an in-memory configuration and inserts your
   breakpoints.

`vmlinux-gdb.py` is auto-loaded for the `lx-*` commands (prefix them with
`-exec` in cpptools). Ending the session kills QEMU.

---

## Kernel Git tab

### Series: check, format, generate, send

A **series** is the commits of the current branch on top of a base.

- **Base:** the one you pick in the view, else the branch's upstream, else
  `kernelDev.patches.base` (`origin/master`).
- **Version:** `vN` is kept per branch.

**Check working changes** runs checkpatch on uncommitted changes.

**Check series** does:

- **checkpatch** on every commit, with `--strict` and an ignore list as
  options. Each commit shows a pass, warning or error icon, and its report opens from
  checkpatch's report.
- **W=1** on every `.c` file the series touches, using the Kernel tab's build.
  This works even for files disabled in `.config`.
- **sparse** (`C=2`), optional. If Kbuild skips sparse because it is missing
  or too old for the kernel, that is reported instead of looking clean.
- **Coccinelle** (`coccicheck MODE=report`), optional. It needs `coccinelle`
  and `ocaml-nox`.
- **DT checks** when the series touches devicetree files.

Findings go to Problems, on the right line of the working tree: findings from
earlier commits are mapped through the later changes. Commit-message
problems (Signed-off-by, Fixes: format, long lines) stay with the commit.

**Format changed lines** runs `git clang-format` against the base: only lines
you changed are reformatted.

**Patches:**

- **Subject prefix:** `PATCH`, `PATCH net-next`, `RFC PATCH`, …
- **Cover letter:** *Edit…* stores it as the git branch description, which
  `git format-patch` reads, so it survives regenerating.
- **To / Cc:** *Fill from get_maintainer.pl* puts maintainers and reviewers in
  To and lists in Cc. Both are editable.
- **Generate patches:** `git format-patch -v N --cover-letter --base=… --to/--cc
  … -o patches/<branch>/v<N>`. If checkpatch reports **errors**, it lists them
  and only continues on *Generate Anyway*.

**Send:**

- **Dry run** (`git send-email --dry-run`) lists every mail and every
  recipient.
- **Send…** is only enabled after a successful dry run of exactly these files.
  It asks once and runs `git send-email` in a terminal, where SMTP can ask for
  a password.
- **SMTP:** configure it yourself (`git config --global sendemail.smtpServer …`).

### Apply: series from lore

1. Paste a lore link or a Message-ID and press **Fetch**. `b4 am` takes the
   latest version, puts the patches in order, collects Reviewed-by / Acked-by
   / Tested-by from the replies, and adds `Link:` trailers.
2. Check what you're about to apply: the subject, patches, base commit and
   trailers. Local `.mbox` / `.patch` files work too.
3. Apply with `git am -3`, either **on the current branch** or **on a new
   branch** at the series' base commit.
4. If `git am` stops, the view shows the patch number and conflicted files,
   which open in the editor. **Continue** (refused while conflict markers
   remain), **Skip** and **Abort**.

### Bisect

- **Manual:** start with a bad and a good commit. Each step offers **Build**
  and **Boot** (the Kernel tab's selection), then **Good / Bad / Skip**.
- **Automatic:** `git bisect run` with your test script. Each step builds the
  kernel first; a build failure skips the commit.
- **Result:** the first bad commit opens, with *Copy Fixes: line*.

---

## History tab

### File History

- **List:** every commit that touched the open file, following renames, 200
  at a time, filterable by message or author.
- **Open a commit:** clicking one opens it as a **full editor tab**, read-only
  and searchable. A toggle switches between the whole commit and this file
  only.
- **Right-click a commit:** copy hash, copy Fixes: line, open the file at that
  commit, compare with the previous version, or open on lore.
- **Selected lines:** *Show History of Selected Lines* (`git log -L`).

### Blame

- **Annotations:** *Toggle Blame Annotations* (editor context menu) shows
  hash, date and author per line. Unsaved edits stay aligned.
- **Click the hash** to open that commit in a full tab. A commit too large
  for an editor tab (the 2.6.12 import) opens as just this file's part of it.
- **Hover:** links to open the commit, blame before it, or copy its Fixes:
  line.
- **Blame view:** follows the cursor. It shows the commit that last changed
  the line and every earlier commit that changed it (`git log -L`). The
  bottom one introduced the line.
- **Blame Before This Commit:** reopens the file as of the parent, at the
  same line, to step past whitespace fixes and refactors.
- **Options:** whitespace is ignored by default; `-M -C` move detection is
  optional (slower).

---

## KUnit (Testing view)

- **What runs:** `tools/testing/kunit/kunit.py run` for the selected arch and
  toolchain, in its own build directory (`build/kunit/<arch>`).
- **Tests:** suites and cases appear after the first run. A failure links to
  its `EXPECTATION FAILED at file:line`, and single suites or tests can be
  re-run.
- **This directory:** *Run KUnit Tests for This Directory* uses the nearest
  `.kunitconfig`.

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
| `kernelDev.blame.ignoreWhitespace` / `detectMoves` | `true` / `false` | |
| `kernelDev.kunit.buildDirectory` / `kunitconfig` | `build/kunit/${arch}` / `""` | |

`Kernel: Open Settings` shows all of them.

## Install

No Node.js needed:

```sh
./scripts/package-vsix.sh            # -> kernel-workbench-<version>.vsix
code   --install-extension kernel-workbench-<version>.vsix
codium --install-extension kernel-workbench-<version>.vsix
```

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

The tool check runs when the extension loads and whenever you change arch,
toolchain or options. It covers what Configure, Build, Run, Debug and the
enabled checks need, and lists what's missing by step with the `apt-get
install` command (*Run Install Command* / *Copy Command*). The Kernel panel
shows the same under **Tools**.
