-- Migration 007: index the foreign key categories.discipline_id (Supabase performance advisor).
create index if not exists categories_discipline_idx on public.categories (discipline_id);
