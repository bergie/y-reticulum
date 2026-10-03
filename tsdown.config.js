import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: {
      'codemirror': 'demo-src/codemirror.js',
    },
    platform: 'browser',
    format: 'esm',
    outDir: 'demo',
    dts: false,
    comments: true,
    compilerOptions: {
      allowJs: true,
      declarationMap: true,
      isolatedDeclarations: true,
    },
    deps: {
      onlyImport: ['path', 'module', 'node:stream/web'],
      alwaysBundle: [
        'lib0/observable',
        'lib0/math',
        'lib0/map',
        'lib0/encoding',
        'lib0/decoding',
        'lib0/random',
        'lib0/promise',
        'lib0/buffer',
        'lib0/error',
        'lib0/binary',
        'lib0/function',
        'lib0/set',
        'lib0/logging',
        'lib0/time',
        'lib0/string',
        'lib0/iterator',
        'lib0/object',
        'lib0/pair',
        'lib0/array',
        'lib0/environment',
        'lib0/dom',
        'lib0/webcrypto',
        'lib0/mutex',
        'y-protocols/awareness',
        'y-protocols/sync',
        '@reticulum/core',
        '@reticulum/core/src/interfaces/websocket.js',
        '@digitaldefiance/bzip2-wasm',
      ],
    },
    copy: [
      {
        from: 'demo-src/codemirror.html',
        to: 'demo/',
      },
      {
        from: 'node_modules/@digitaldefiance/bzip2-wasm/bzip2-1.0.8/bzip2.wasm',
        to: 'demo/',
      },
    ],
  },
])
