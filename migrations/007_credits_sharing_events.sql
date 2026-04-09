-- =============================================================================
-- Migration 007: reset_tokens, shared_looks, events
-- =============================================================================

-- ── reset_tokens: tokens de 6 dígitos para reset de contraseña seguro ────────
CREATE TABLE IF NOT EXISTS public.reset_tokens (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email      text NOT NULL,
    token      text NOT NULL,
    expires_at timestamptz NOT NULL,
    used       boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_email ON public.reset_tokens(email);

-- ── shared_looks: looks generados que se comparten públicamente ───────────────
CREATE TABLE IF NOT EXISTS public.shared_looks (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     text REFERENCES public.users(id) ON DELETE SET NULL,
    garment_id  text,
    result_url  text NOT NULL,
    garment_name  text,
    garment_brand text,
    company_name  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shared_looks_user ON public.shared_looks(user_id);

-- ── events: tracking de eventos (fire-and-forget) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     text,
    company_id  uuid,
    event_name  text NOT NULL,
    properties  jsonb DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_user       ON public.events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_company    ON public.events(company_id);
CREATE INDEX IF NOT EXISTS idx_events_name       ON public.events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON public.events(created_at DESC);

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
