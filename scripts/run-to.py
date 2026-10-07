# Sourced by gdb: run a halted QEMU guest to a symbol, then leave it halted.
#
#   KD_TARGET=localhost:1234 KD_SYMBOL=start_kernel \
#     gdb -q -nx -batch -ex 'file vmlinux' -x run-to.py
#
# A hardware breakpoint is used because at reset the MMU is off (and an x86
# bzImage has not decompressed the kernel yet), so a software breakpoint
# would fail to insert or be overwritten. `disconnect` rather than `detach`:
# QEMU resumes the guest on detach but stays paused when the connection just
# drops, so the IDE debugger can attach to a guest sitting at the symbol.
import os
import sys

import gdb

target = os.environ["KD_TARGET"]
symbol = os.environ["KD_SYMBOL"]

gdb.execute("set pagination off")
gdb.execute("set confirm off")
try:
    gdb.execute("set debuginfod enabled off")
except gdb.error:
    pass

try:
    gdb.parse_and_eval("&" + symbol)
except gdb.error:
    print(f"kernel-dev: symbol {symbol} not found in vmlinux", file=sys.stderr)
    raise

gdb.execute(f"target remote {target}")
bp = gdb.Breakpoint(symbol, type=gdb.BP_HARDWARE_BREAKPOINT, internal=True)
gdb.execute("continue")
pc = int(gdb.parse_and_eval("$pc"))
where = gdb.execute("info symbol $pc", to_string=True).strip()
bp.delete()
if where.split()[0] == symbol:
    print(f"kernel-dev: stopped at {symbol} (pc={pc:#x})")
else:
    print(f"kernel-dev: stopped at {where}, not {symbol}", file=sys.stderr)
gdb.execute("disconnect")
