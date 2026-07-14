import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const OUTPUT_DIRECTORY = 'out';
const MAIN_OUTPUT_DIRECTORY = `${OUTPUT_DIRECTORY}/main`;
const PRELOAD_OUTPUT_DIRECTORY = `${OUTPUT_DIRECTORY}/preload`;
const RENDERER_OUTPUT_DIRECTORY = `${OUTPUT_DIRECTORY}/renderer`;
const COMMONJS_FORMAT = 'cjs';
const ELECTRON_MODULE = 'electron';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: MAIN_OUTPUT_DIRECTORY },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: PRELOAD_OUTPUT_DIRECTORY,
      rollupOptions: {
        external: [ELECTRON_MODULE],
        output: { format: COMMONJS_FORMAT },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: { outDir: RENDERER_OUTPUT_DIRECTORY },
  },
});
