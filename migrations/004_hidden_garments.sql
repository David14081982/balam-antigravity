-- =============================================================================
-- Migration 004: Add hidden column to catalog_garments
-- false = visible (default), true = oculta para el público
-- =============================================================================

ALTER TABLE public.catalog_garments
    ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
