declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

declare module '*.WAD' {
  const bytes: ArrayBuffer;
  export default bytes;
}
