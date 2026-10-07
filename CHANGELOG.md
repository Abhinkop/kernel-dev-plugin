# Changelog

## 0.7.0

First release on the VS Code Marketplace and Open VSX.

- Kernel tab: Configure, Build, Run and Debug the kernel in QEMU for
  x86_64, arm64 and riscv64, with Debug/Release builds, GCC or LLVM, an
  optional initramfs, ccache, module loading over a 9p share, crash
  decoding and devicetree checks.
- Kernel Git tab: patch series with checkpatch, W=1, sparse and
  Coccinelle checks, git clang-format, get_maintainer.pl, git
  format-patch and git send-email; applying series from lore with b4 and
  git am; bisect.
- History tab: file history and blame, with clickable commit hashes that
  open the commit in an editor tab.
- KUnit tests in the Testing view.
- clangd set up from the build's compile_commands.json.
