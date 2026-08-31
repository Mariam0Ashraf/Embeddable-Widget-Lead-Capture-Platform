import 'dotenv/config';
import { z } from 'zod';

// Environment is parsed once, at boot, through a schema. A missing or malformed
// variable kills the process here rather than surfacing as a confusing 500 later.

const bool = z
  .string()
  .transform((v) => v.toLowerCase() === 'true' || v === '1')
  .pipe(z.boolean());

const int = z.coerce.number().int();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int.default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  BCRYPT_ROUNDS: int.min(4).max(15).default(10),

  WIDGET_BUILD_VERSION: z.string().default('1'),
  CONFIG_CACHE_MAX_AGE: int.default(60),
  LOADER_CACHE_MAX_AGE: int.default(300),
  BUNDLE_CACHE_MAX_AGE: int.default(31536000),

  SUBMISSION_BODY_LIMIT: z.string().default('16kb'),
  RATE_LIMIT_WINDOW_MS: int.default(60000),
  RATE_LIMIT_MAX_PER_IP: int.default(20),
  RATE_LIMIT_MAX_PER_WIDGET: int.default(60),
  SPAM_MIN_FILL_MS: int.default(1200),

  GEO_ENABLED: bool.default(true),
  GEO_TIMEOUT_MS: int.default(1500),
  GEO_PROVIDER_A_MODE: z.enum(['live', 'mock_ok', 'down']).default('live'),
  GEO_PROVIDER_B_MODE: z.enum(['live', 'mock_ok', 'down']).default('live'),

  SIDE_EFFECT_TRANSPORT: z.enum(['console', 'smtp', 'webhook', 'fail']).default('console'),
  SIDE_EFFECT_WEBHOOK_URL: z.string().default(''),
  SIDE_EFFECT_MAX_ATTEMPTS: int.min(1).default(3),
  WORKER_POLL_MS: int.default(1000),
  WORKER_ENABLED: bool.default(true),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: int.default(1025),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default('no-reply@widgets.local'),

  DEMO_SITE_ORIGIN: z.string().default('http://localhost:5500'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  // Never print the values themselves — only which variable is wrong.
  console.error(`Invalid environment configuration:\n${details}`);
  process.exit(1);
}

export const config = Object.freeze(parsed.data);

export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
