import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts', mcp: 'src/mcp.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  splitting: false,
  sourcemap: false,
  minify: false,
})
