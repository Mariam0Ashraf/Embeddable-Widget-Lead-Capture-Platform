import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    globalSetup: ['./tests/setup/global-setup.js'],
    testTimeout: 20_000,
    hookTimeout: 30_000,

    // One process, files in sequence. The rate limiters are per-process state and
    // the suite shares one database, so parallel files would make the abuse tests
    // flaky for reasons that have nothing to do with the code under test.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,

    // The whole point of these values is determinism. Providers are pinned to
    // mock modes so the fallback proof never depends on a third party being up,
    // and the limits are small so a burst test takes milliseconds.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://widget:widget@localhost:5433/widgets_test',
      JWT_SECRET: 'test-secret-not-used-anywhere-real',
      PUBLIC_BASE_URL: 'http://localhost:3000',
      DEMO_SITE_ORIGIN: 'http://localhost:5500',

      RATE_LIMIT_WINDOW_MS: '60000',
      RATE_LIMIT_MAX_PER_IP: '5',
      RATE_LIMIT_MAX_PER_WIDGET: '8',
      SPAM_MIN_FILL_MS: '1200',
      SUBMISSION_BODY_LIMIT: '16kb',

      GEO_ENABLED: 'true',
      GEO_PROVIDER_A_MODE: 'down',
      GEO_PROVIDER_B_MODE: 'mock_ok',

      SIDE_EFFECT_TRANSPORT: 'console',
      SIDE_EFFECT_MAX_ATTEMPTS: '3',
      WORKER_ENABLED: 'false',
    },
  },
});
