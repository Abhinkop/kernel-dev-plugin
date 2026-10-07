# Kernel Dev — Configure · Build · Run · Debug

Visual Studio-style kernel development in VS Code and VSCodium. Install the
extension and open a kernel source tree. You get:

- **A Kernel panel** (chip icon in the left activity bar). It has dropdowns for
  **Architecture**, **Build** (Debug / Release) and **Base config**, big
  **Configure / Build / Run / Debug** buttons, and menuconfig / Clean /
  Rebuild / Full clean (mrproper) / Stop VM. It shows the state of each step and has an **Options**
  section where you edit toolchain, `CROSS_COMPILE`, make args, config
  fragments and options, busybox path, QEMU args, kernel cmdline, memory, and CPUs.
- **An editor toolbar** (top right of every editor) with a target dropdown
  that has checkmarks for arch and Debug/Release, plus the config picker and
  ⚙ Configure, 🔨 Build, ▶ Run, and 🐞 Debug buttons.

Nothing is written into `.vscode/`. There is no `tasks.json`, no
`launch.json`, and no project file. Options are VS Code settings
(`kernelDev.*`), saved at user level, so every kernel tree uses them. A
workspace override is respected if you add one.

## The workflow

| Step | Key | What it does |
|---|---|---|
| **Configure** | | Applies, in order: the selected base config (default `defconfig`), `configure.fragments`, the run-mode options, the Debug or Release options, then `configure.options`. Then it runs `make olddefconfig`. The make arguments used (`O=`, `ARCH=`, toolchain, `make.args`) are recorded in the build directory. Requested options that Kconfig dropped are listed. |
| **Build** | F7 | Runs `make` with exactly the recorded arguments, and configures first if needed. Errors go to the Problems panel. Then it refreshes `compile_commands.json` for clangd. |
| **Run** | Ctrl+F5 | Runs an incremental build, then boots the selected variant's kernel in QEMU. The rootfs is an initramfs packed around your busybox. |
| **Debug** | F5 | Runs an incremental build, boots QEMU paused, runs to `start_kernel`, and attaches gdb. Breakpoints work, including in initcalls, and the `lx-*` gdb commands are available. |

- **Debug / Release** are separate build directories: `build/<arch>/debug` and
  `build/<arch>/release` (like Visual Studio's `x64\Debug`). Switching between them doesn't rebuild the other, and
  Run and Debug always use the selected variant's binaries.
- **Changing arguments:** they take effect at the next Configure, the same as
  in CMake.

Also available:
- **Ctrl+F7** compiles the current file.
- Right-click a `.c` file → *Preprocess (.i)* or *Show Assembly (.s)*.
- `Kernel: menuconfig`, `Kernel: Clean`, `Kernel: Rebuild`, and
  `Kernel: Full Clean (mrproper)` in the command palette.

## Rootfs: point it at busybox

To boot, the kernel needs a rootfs. Set the path to a **statically linked**
busybox for each arch you boot:

```jsonc
"kernelDev.run.busybox": {
  "arm64":   "/opt/busybox/arm64/busybox",
  "riscv64": "/opt/busybox/riscv64/busybox"
}
```

For the host arch, `busybox` on `PATH` is used if it is static (Debian/Ubuntu:
`busybox-static`). The extension packs it into
`<build dir>/kernel-dev/initramfs.cpio.gz` with the kernel's own
`gen_init_cpio`. The `/init` script mounts proc, sys, dev, tmp, debugfs and
tracefs, then drops to a shell. The initramfs is repacked whenever the busybox
binary changes. It checks that the binary is static and matches the arch.

You can use your own image instead with
`"kernelDev.run.initramfs": { "arm64": "/path/initramfs.cpio.gz" }`. With
`"kernelDev.run.mode": "virtme"`, it boots the host rootfs with virtme-ng
(`vng`) instead.

## Settings

| Setting | Default | |
|---|---|---|
| `kernelDev.toolchain` | `gcc` | `gcc` or `llvm` (`LLVM=1`) |
| `kernelDev.crossCompile` | per-arch GNU triples | e.g. `{ "arm64": "aarch64-none-linux-gnu-" }` |
| `kernelDev.configure.defconfig` | `defconfig` | make target(s) or a `.config` path; the Base config dropdown overrides it per arch |
| `kernelDev.configure.fragments` | `[]` | merged with `merge_config.sh` |
| `kernelDev.configure.options` | `{}` | `{ "KASAN": "y", "LOG_BUF_SHIFT": "18" }` |
| `kernelDev.configure.debugOptions` | DWARF, `GDB_SCRIPTS` | the Debug variant |
| `kernelDev.configure.releaseOptions` | `DEBUG_INFO_NONE` | the Release variant |
| `kernelDev.make.args` | `[]` | e.g. `["W=1"]`, `["CC=ccache gcc"]` |
| `kernelDev.make.jobs` | `0` | `0` = all CPUs |
| `kernelDev.terminal.afterTask` | `waitForKey` | `waitForKey`: the step's terminal stays open until you press a key. `close`: it closes when the step finishes; errors stay in Problems |
| `kernelDev.buildDirectory` | `build/${arch}/${variant}` | relative to the tree, or absolute |
| `kernelDev.run.busybox` | `{}` | see above |
| `kernelDev.run.memory` / `smp` / `kvm` | `2G` / `2` / `auto` | |
| `kernelDev.run.cmdline` | `""` | extra kernel command line |
| `kernelDev.run.qemuArgs` | `[]` | extra QEMU arguments |
| `kernelDev.debug.debugger` | `auto` | cpptools (VS Code), Native Debug `webfreak.debug` (VSCodium), or CodeLLDB |
| `kernelDev.debug.breakAt` | `start_kernel` | where the guest is stopped before the debugger attaches |
| `kernelDev.debug.stopOnEntry` | `false` | stay paused there instead of running to your breakpoints |
| `kernelDev.debug.gdbCommands` | `[]` | extra gdb commands at start |

`Kernel: Open Settings` shows them all.

## clangd

After each build, the build's `compile_commands.json` is written to the root
of the tree, which is where clangd looks by default. The kernel's
`.gitignore` already ignores that file. For GCC builds, the gcc-only flags clang
rejects are stripped and the clang target is set. clangd is then restarted.
Switching arch or variant re-points it at that build. No `.clangd` or settings
are written. Turn this off with `kernelDev.clangd.updateCompileCommands`.

## How Debug works

QEMU starts with `-S` and a gdbstub. At reset the MMU is off, and on x86 the
kernel isn't even decompressed yet, so software breakpoints set by the IDE
would fail or be overwritten. A short-lived gdb therefore runs the guest to
`start_kernel` on a hardware breakpoint and disconnects, which leaves QEMU
paused there. Then the IDE debugger attaches with an in-memory configuration
and inserts your breakpoints. `vmlinux-gdb.py` is auto-loaded, so `lx-dmesg`,
`lx-ps` and the other `lx-*` commands work in the debug console. With cpptools,
prefix them with `-exec`. Ending the debug session kills QEMU.

## Install

No Node.js needed:

```sh
./scripts/package-vsix.sh            # -> kernel-dev-0.2.0.vsix
code   --install-extension kernel-dev-0.2.0.vsix
codium --install-extension kernel-dev-0.2.0.vsix
```

Host packages (Debian/Ubuntu):

```sh
sudo apt install build-essential flex bison bc libelf-dev libssl-dev \
                 qemu-system-x86 qemu-system-arm qemu-system-misc \
                 gdb gdb-multiarch busybox-static
sudo apt install gcc-aarch64-linux-gnu gcc-riscv64-linux-gnu   # cross gcc
sudo apt install clang lld llvm                                 # toolchain=llvm
```

When the extension loads, and whenever you change arch, toolchain or run mode,
it checks for everything Configure, Build, Run and Debug need. That covers the
compiler or cross compiler, make, flex, bison, bc, perl, python3, the libelf and
OpenSSL headers, QEMU or vng, busybox, and gdb. If something is missing it
shows an error listing it by step, with the `apt-get install` command
(*Run Install Command* / *Copy Command*). The Kernel panel shows the same under
**Tools**. `Kernel: Check Required Tools` runs the check on demand.
