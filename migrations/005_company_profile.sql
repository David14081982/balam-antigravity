-- =============================================================================
-- Migration 005: Add social media and logo fields to companies
-- All nullable — existing companies unaffected
-- =============================================================================

ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS instagram  text,
    ADD COLUMN IF NOT EXISTS facebook   text,
    ADD COLUMN IF NOT EXISTS tiktok     text,
    ADD COLUMN IF NOT EXISTS logo_file  text;

-- Note: logo_url already exists from migration 001
-- logo_file stores the local filename (served from /logos/)
-- logo_url can store an external URL as fallback

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
