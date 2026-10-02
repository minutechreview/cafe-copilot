import { defineConfig } from 'vitest/config';

// Keep workspace tests independent when this repo is checked out inside another Vite app.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{mjs,js,jsx}'],
  },
});
