#!/usr/bin/env bash
#
# Rebuild Chocolate Doom's objects, link a standalone doom.wasm and stage it
# (plus the IWAD) in worker/src/ so Wrangler can bundle both.
#
#   ./worker/build.sh                  # uses doom95/DOOM1.WAD
#   WAD=/path/to/freedoom1.wad ./worker/build.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/worker/src"
WAD="${WAD:-$ROOT/doom95/DOOM1.WAD}"

if ! command -v emcc >/dev/null; then
    # emsdk_env.sh trips over `set -u`
    set +u
    source "${EMSDK:-$HOME/Github/emsdk}/emsdk_env.sh" >/dev/null
    set -u
fi

cd "$ROOT"

# Static libs first, then the doom objects (the .html target compiles
# everything in src/ and src/doom/ that the link below needs).
for dir in textscreen pcsound opl; do
    emmake make -C "$dir"
done
emmake make -C src chocolate-doom.html

# WASMFS gives the module an in-memory filesystem; the Worker writes the WAD
# into it at startup via _wasmfs_write_file. __wasm_call_ctors must be called
# by the host before anything else since there is no _start in reactor mode.
emcc -O3 \
    -s WASM=1 \
    -s STANDALONE_WASM=1 \
    -Wl,--no-entry \
    -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
    -s WASMFS=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s USE_SDL=2 \
    -s EXPORTED_FUNCTIONS="['_worker_doom_init','_worker_doom_tick','_worker_get_framebuffer','___wasm_call_ctors','_malloc','_free','__wasmfs_write_file']" \
    src/*.o \
    -Wl,--start-group \
        src/doom/libdoom.a \
        textscreen/libtextscreen.a \
        pcsound/libpcsound.a \
        opl/libopl.a \
    -Wl,--end-group \
    -o "$OUT/doom.wasm"

cp "$WAD" "$OUT/DOOM1.WAD"

ls -lh "$OUT/doom.wasm" "$OUT/DOOM1.WAD"
