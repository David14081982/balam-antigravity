-- =============================================================================
-- Migration 006: Showcase images for the "Crea tu apariencia" screen
-- One row per slot: main | left | right | face
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.showcase_images (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slot       text NOT NULL UNIQUE CHECK (slot IN ('main','left','right','face')),
    filename   text NOT NULL,
    url        text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
