export interface Env {
  DB: D1Database;
  APP_NAME: string;
  AUTH_OTP_TTL_SECONDS: string;
  AUTH_SESSION_TTL_SECONDS: string;
  // When truthy, the one-time login code is echoed in the /auth/send response.
  // Dev convenience only; in production the code is only emailed.
  AUTH_EXPOSE_CODE: string;
  JWT_SECRET: string;
  ADMIN_API_KEY: string;
  // Optional token that gates the bootstrap /auth/setup endpoint once the
  // first account exists.
  SETUP_TOKEN?: string;
  PADDLE_ENVIRONMENT?: "sandbox" | "live";
  PADDLE_API_KEY?: string;
  PADDLE_CLIENT_TOKEN?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICE_PRO?: string;
  PADDLE_PRICE_BUSINESS?: string;
  PADDLE_CHECKOUT_URL?: string;
  // Local/test escape hatch only. Never enable in production.
  BILLING_ALLOW_MANUAL_PLAN_CHANGE?: string;
}
