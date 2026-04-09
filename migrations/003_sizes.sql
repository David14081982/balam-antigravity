-- =============================================================================
-- Migration 003: Add sizes column to catalog_garments
-- jsonb array, nullable — existing rows unaffected
-- =============================================================================

ALTER TABLE public.catalog_garments
    ADD COLUMN IF NOT EXISTS sizes jsonb DEFAULT '[]'::jsonb;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
