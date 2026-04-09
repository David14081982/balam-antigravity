-- =============================================================================
-- Migration 008: user auth columns + verification_codes table
-- =============================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS name          text,
  ADD COLUMN IF NOT EXISTS phone         text,
  ADD COLUMN IF NOT EXISTS is_verified   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_registered boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.verification_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text NOT NULL,
  code       text NOT NULL,
  channel    text NOT NULL DEFAULT 'email',
  expires_at timestamptz NOT NULL,
  used       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vcodes_user ON public.verification_codes(user_id);

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
