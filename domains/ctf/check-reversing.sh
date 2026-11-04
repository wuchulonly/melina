#!/usr/bin/env bash
set -euo pipefail

# Keep compiled files and native-library caches in the private HOME.
reverse_tmp=$(mktemp -d "$HOME/ctf-reverse-check.XXXXXX")
trap 'rm -rf "$reverse_tmp"' EXIT
require_output() {
    if ! grep -Fq "$1" "$2"; then
        cat "$2" >&2
        printf 'Missing reverse-engineering check result: %s\n' "$1" >&2
        exit 1
    fi
}

cat > "$reverse_tmp/probe.c" <<'C'
__attribute__((noinline)) int check_value(unsigned int value) {
    return (value ^ 0x5aU) == 42U;
}
int main(void) { return check_value(112U) ? 0 : 1; }
C
gcc -g -O0 -fno-pie -no-pie -o "$reverse_tmp/probe" "$reverse_tmp/probe.c"

# Debug a child process with the Runtime's normal seccomp/capability settings.
# Keeping ASLR avoids the unrelated, restricted personality() operation.
if ! gdb -nx -batch -ex 'set debuginfod enabled off' -ex 'set disable-randomization off' \
    -ex 'break check_value' -ex run -ex 'printf "CTF_GDB_VALUE=%u\n", value' \
    -ex continue "$reverse_tmp/probe" > "$reverse_tmp/gdb.log" 2>&1; then
    cat "$reverse_tmp/gdb.log" >&2
    exit 1
fi
require_output CTF_GDB_VALUE=112 "$reverse_tmp/gdb.log"
printf 'gdb child-process debugging: OK\n'

radare2 -2 -q -c 'aaa;afij @ sym.check_value' "$reverse_tmp/probe" > "$reverse_tmp/radare2.json"
python3 - "$reverse_tmp/radare2.json" <<'PY'
import json
import sys
with open(sys.argv[1]) as source:
    functions = json.load(source)
assert any(f["name"].endswith("check_value") and f["size"] > 0 for f in functions), functions
print("radare2 ELF function analysis: OK")
PY

python3 - "$reverse_tmp/probe" <<'PY'
import sys
import angr
from angr import claripy

project = angr.Project(sys.argv[1], auto_load_libs=False)
address = project.loader.find_symbol("check_value").rebased_addr
value = claripy.BVS("value", 32)
state = project.factory.call_state(
    address, value, prototype="int check_value(unsigned int value)",
    add_options={angr.options.ZERO_FILL_UNCONSTRAINED_MEMORY, angr.options.ZERO_FILL_UNCONSTRAINED_REGISTERS},
)
simulation = project.factory.simulation_manager(state)
simulation.run()
solutions = {
    end.solver.eval(value, extra_constraints=[end.regs.eax == 1])
    for end in simulation.deadended
    if end.solver.satisfiable(extra_constraints=[end.regs.eax == 1])
}
assert not simulation.errored, simulation.errored
assert solutions == {112}, solutions
print("angr ELF symbolic execution: value=112, OK")
PY

cat > "$reverse_tmp/ToolchainDecompile.java" <<'JAVA'
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.Function;

public class ToolchainDecompile extends GhidraScript {
    public void run() throws Exception {
        DecompInterface decompiler = new DecompInterface();
        try {
            if (!decompiler.openProgram(currentProgram)) throw new Exception("Cannot open program");
            for (Function function : currentProgram.getFunctionManager().getFunctions(true)) {
                if (!function.getName().equals("check_value")) continue;
                DecompileResults result = decompiler.decompileFunction(function, 30, monitor);
                if (!result.decompileCompleted() || result.getDecompiledFunction() == null)
                    throw new Exception(result.getErrorMessage());
                if (!result.getDecompiledFunction().getC().contains("check_value"))
                    throw new Exception("Missing C output");
                println("CTF_GHIDRA_DECOMPILE_OK");
                return;
            }
            throw new Exception("Missing check_value function");
        } finally {
            decompiler.dispose();
        }
    }
}
JAVA
mkdir "$reverse_tmp/projects"
if ! analyzeHeadless "$reverse_tmp/projects" toolchain -import "$reverse_tmp/probe" \
    -scriptPath "$reverse_tmp" -postScript ToolchainDecompile.java -deleteProject \
    -max-cpu 2 -analysisTimeoutPerFile 60 > "$reverse_tmp/ghidra.log" 2>&1; then
    cat "$reverse_tmp/ghidra.log" >&2
    exit 1
fi
require_output CTF_GHIDRA_DECOMPILE_OK "$reverse_tmp/ghidra.log"
printf 'Ghidra headless ELF decompilation: OK\n'
