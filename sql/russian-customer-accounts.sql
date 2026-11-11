-- Execute this migration ONLY in a separate PostgreSQL database hosted in Russia.
-- Do not execute in the existing Stockholm Supabase project.
-- Restrict the application's database user to these account tables.
BEGIN;
CREATE TABLE IF NOT EXISTS customer_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login VARCHAR(32) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  favorites JSONB NOT NULL DEFAULT '[]'::jsonb,
  cart JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT login_format CHECK(login ~ '^[a-z0-9_.-]{3,32}$'),
  CONSTRAINT favorites_array CHECK(jsonb_typeof(favorites) = 'array'),
  CONSTRAINT cart_array CHECK(jsonb_typeof(cart) = 'array')
);
CREATE TABLE IF NOT EXISTS customer_auth_attempts (
  id CHAR(64) PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_profiles_created_idx
  ON customer_profiles(created_at DESC);
COMMIT;
