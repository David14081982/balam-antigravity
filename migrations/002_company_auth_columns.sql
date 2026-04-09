-- =============================================================================
-- Migration 002: Add email + password_hash to users for company owners
-- Nullable so existing anonymous users are unaffected.
-- =============================================================================

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS email         text UNIQUE,
    ADD COLUMN IF NOT EXISTS password_hash text;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
