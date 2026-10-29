import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        options: resolve(__dirname, 'options.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        'yt-bridge': resolve(__dirname, 'src/content/youtube/yt-bridge.ts'),
        'content-style': resolve(__dirname, 'src/content/content.css')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') return 'background.js';
          if (chunkInfo.name === 'content') return 'content.js';
          if (chunkInfo.name === 'yt-bridge') return 'yt-bridge.js';
          return 'assets/[name].js';
        },
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'content.css' || assetInfo.name === 'content-style.css') {
            return 'content.css';
          }
          if (assetInfo.name === 'popup.css') {
            return 'popup.css';
          }
          if (assetInfo.name === 'options.css') {
            return 'options.css';
          }
          return 'assets/[name].[ext]';
        }
      }
    }
  }
});
