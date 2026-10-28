// Supabase project settings. The publishable key is meant to be public:
// security comes from the database rules in supabase/schema.sql, not from
// hiding this key. NEVER put a secret / service_role key here.

export const SUPABASE_URL = 'https://uzfzkosftfpyhhevjgee.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_dV225SliNliUkdV40zRwHQ_jQhKbrom';

// Shown in the header and on the login page.
export const APP_NAME = 'USMF Exam Prep';

// Shuffle answer options on each question (options such as "All of the above"
// keep the original order automatically).
export const SHUFFLE_OPTIONS = true;
