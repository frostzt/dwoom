// Host side of doom.wasm: provides the imports the module needs, loads the
// IWAD into WasmFS and exposes tick / framebuffer / palette.

import doomWasm from './doom.wasm';
import wadBytes from './DOOM1.WAD';

export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 200;
export const TICRATE = 35;

// Bits understood by worker_doom_tick() in src/i_main.c.
export const INPUT = {
  UP: 1 << 0,
  DOWN: 1 << 1,
  LEFT: 1 << 2,
  RIGHT: 1 << 3,
  FIRE: 1 << 4,
  USE: 1 << 5,
  ENTER: 1 << 6,  // not handled in C yet
  ESCAPE: 1 << 7, // not handled in C yet
} as const;

const NS_PER_TIC = 1_000_000_000n / BigInt(TICRATE);

// Workers freeze Date.now() while code runs, so Doom gets a virtual clock.
// Each clock read nudges it forward a little so busy-wait loops (I_Sleep,
// wipes, TryRunTics) still terminate; each game tick advances a full tic.
const NS_PER_CLOCK_READ = 10_000n;

const WASI_EBADF = 8;

interface DoomExports {
  memory: WebAssembly.Memory;
  __wasm_call_ctors(): void;
  malloc(size: number): number;
  free(ptr: number): void;
  _wasmfs_write_file(path: number, data: number, size: number): number;
  worker_doom_init(): number;
  worker_doom_tick(inputMask: number): void;
  worker_get_framebuffer(): number;
}

export class DoomExit extends Error {}

export class DoomEngine {
  private exports!: DoomExports;
  private clock = 0n;
  private stdout = '';

  static async create(): Promise<DoomEngine> {
    const engine = new DoomEngine();
    const instance = await WebAssembly.instantiate(doomWasm, engine.imports());
    engine.exports = instance.exports as unknown as DoomExports;

    engine.exports.__wasm_call_ctors();
    engine.writeFile('/DOOM1.WAD', new Uint8Array(wadBytes));
    engine.exports.worker_doom_init();
    engine.flushStdout();

    return engine;
  }

  tick(inputMask: number): void {
    this.clock += NS_PER_TIC;
    this.exports.worker_doom_tick(inputMask);
    this.flushStdout();
  }

  // Copy of the 320x200 8-bit palette-indexed screen.
  frame(): Uint8Array {
    const ptr = this.exports.worker_get_framebuffer();
    return new Uint8Array(this.exports.memory.buffer, ptr, SCREEN_WIDTH * SCREEN_HEIGHT).slice();
  }

  // Palette 0 of the IWAD's PLAYPAL lump (256 RGB triplets). Damage and
  // pickup tints are separate palettes the engine switches between; those
  // aren't exported from C yet, so clients always use the base palette.
  static palette(): Uint8Array {
    const wad = new DataView(wadBytes);
    const numLumps = wad.getInt32(4, true);
    const dirOffset = wad.getInt32(8, true);
    const decoder = new TextDecoder('latin1');

    for (let i = 0; i < numLumps; i++) {
      const entry = dirOffset + i * 16;
      const name = decoder.decode(new Uint8Array(wadBytes, entry + 8, 8)).replace(/\0.*$/, '');
      if (name === 'PLAYPAL') {
        return new Uint8Array(wadBytes, wad.getInt32(entry, true), 768).slice();
      }
    }
    throw new Error('PLAYPAL lump not found in WAD');
  }

  private get view(): DataView {
    // Recreated on every access: memory.grow() detaches old buffers.
    return new DataView(this.exports.memory.buffer);
  }

  private writeFile(path: string, data: Uint8Array): void {
    const { malloc, free, memory, _wasmfs_write_file } = this.exports;
    const pathBytes = new TextEncoder().encode(path + '\0');

    const pathPtr = malloc(pathBytes.length);
    const dataPtr = malloc(data.length);
    new Uint8Array(memory.buffer, pathPtr, pathBytes.length).set(pathBytes);
    new Uint8Array(memory.buffer, dataPtr, data.length).set(data);

    // The return value isn't checked: this emscripten's _wasmfs_write_file
    // returns 0 even on success (the memory backend's write() returns a byte
    // count, which it compares against __WASI_ERRNO_SUCCESS). If the write
    // really failed, Doom exits with "IWAD file not found".
    _wasmfs_write_file(pathPtr, dataPtr, data.length);
    free(dataPtr);
    free(pathPtr);
  }

  private flushStdout(): void {
    const lines = this.stdout.split('\n');
    this.stdout = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) console.log(`[doom] ${line}`);
    }
  }

  private imports(): WebAssembly.Imports {
    const wasi: Record<string, (...args: any[]) => number | void> = {
      fd_write: (_fd: number, iovs: number, iovsLen: number, nwritten: number) => {
        const view = this.view;
        const decoder = new TextDecoder();
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = view.getUint32(iovs + i * 8, true);
          const len = view.getUint32(iovs + i * 8 + 4, true);
          this.stdout += decoder.decode(new Uint8Array(this.exports.memory.buffer, ptr, len));
          total += len;
        }
        view.setUint32(nwritten, total, true);
        return 0;
      },
      fd_read: (_fd: number, _iovs: number, _iovsLen: number, nread: number) => {
        this.view.setUint32(nread, 0, true);
        return 0;
      },
      fd_close: () => 0,
      fd_seek: () => WASI_EBADF,
      fd_fdstat_get: () => WASI_EBADF,
      environ_sizes_get: (count: number, size: number) => {
        this.view.setUint32(count, 0, true);
        this.view.setUint32(size, 0, true);
        return 0;
      },
      environ_get: () => 0,
      clock_time_get: (_id: number, _precision: bigint, out: number) => {
        this.clock += NS_PER_CLOCK_READ;
        this.view.setBigUint64(out, this.clock, true);
        return 0;
      },
      random_get: (ptr: number, len: number) => {
        // getRandomValues() is capped at 64 KiB per call.
        for (let off = 0; off < len; off += 65536) {
          crypto.getRandomValues(new Uint8Array(this.exports.memory.buffer, ptr + off, Math.min(65536, len - off)));
        }
        return 0;
      },
      proc_exit: (code: number) => {
        this.flushStdout();
        throw new DoomExit(`doom exited with code ${code}`);
      },
    };

    // Everything else (SDL, EGL, browser event hooks) is a no-op returning 0.
    // The headless engine calls a handful of these during init and ignores
    // the results.
    const imports: Record<string, Record<string, Function>> = {};
    for (const imp of WebAssembly.Module.imports(doomWasm)) {
      if (imp.kind !== 'function') continue;
      imports[imp.module] ??= {};
      imports[imp.module][imp.name] =
        (imp.module === 'wasi_snapshot_preview1' && wasi[imp.name]) || (() => 0);
    }
    return imports as WebAssembly.Imports;
  }
}
