import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {trace: 'retain-on-failure'}
});
