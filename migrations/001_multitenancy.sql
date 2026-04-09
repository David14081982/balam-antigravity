-- =============================================================================
-- Migration 001: Multitenancy — companies, company_users, company_id on garments
-- Target: Supabase (PostgreSQL)
-- Safe to run on an existing database; catalog_garments rows are preserved.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. COMPANIES
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.companies (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    slug        text NOT NULL UNIQUE,               -- URL-friendly identifier
    logo_url    text,
    description text,
    website     text,
    contact_email text,
    status      text NOT NULL DEFAULT 'pending',    -- pending | active | suspended
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Enable Row-Level Security (must be configured via policies separately)
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 2. COMPANY_USERS  (join table: which users belong to which company)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_users (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id     text NOT NULL REFERENCES public.users(id)     ON DELETE CASCADE,
    role        text NOT NULL DEFAULT 'owner',      -- owner | admin | member
    created_at  timestamptz NOT NULL DEFAULT now(),

    UNIQUE (company_id, user_id)                    -- one record per user per company
);

ALTER TABLE public.company_users ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS company_users_company_id_idx ON public.company_users(company_id);
CREATE INDEX IF NOT EXISTS company_users_user_id_idx    ON public.company_users(user_id);

-- -----------------------------------------------------------------------------
-- 3. ADD company_id TO catalog_garments  (nullable — existing rows unaffected)
-- -----------------------------------------------------------------------------
ALTER TABLE public.catalog_garments
    ADD COLUMN IF NOT EXISTS company_id uuid
        REFERENCES public.companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS catalog_garments_company_id_idx
    ON public.catalog_garments(company_id);

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
