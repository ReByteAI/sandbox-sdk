import { defineConfig } from 'tsup'

export default defineConfig({
  minify: false,
  target: ['es2017'],
  sourcemap: true,
  dts: true,
  format: ['esm', 'cjs'],
  clean: true,
  entry: {
    index: './src/index.ts',
    'vm-lifecycle/index': './vm-lifecycle/index.ts',
    'vm-lifecycle/VmProvider': './vm-lifecycle/VmProvider.tsx',
    'vm-lifecycle/ensureVmRunning': './vm-lifecycle/ensureVmRunning.ts',
  },
  external: [
    'react',
    'react-dom',
    '@tanstack/react-query',
    'express',
    'rebyte-sandbox',
  ],
  esbuildOptions: (options) => {
    options.legalComments = 'none'
    return options
  },
})
