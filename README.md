# MCQ Practice

A small practice app for multiple-choice questions. The admin creates learner accounts and loads question banks. Learners pick categories and practise, and every answer is saved so progress carries across devices.

- **Website:** hosted on GitHub Pages from this repository (`index.html` at the root).
- **Database and logins:** Supabase project `mcq-practice` (Mumbai region).

## What it does

**Learners**
- Sign in with the account the admin gave them, and change their password under their name (top right).
- Choose one or more categories and a mode:
  - **Smart review:** questions due for review plus new ones first. A correct answer comes back after 1, 3, 7, 14, then 30 days. A wrong answer comes back straight away.
  - **Random mix:** shuffled questions from the chosen categories.
  - **My mistakes:** only questions they got wrong last time.
- See the correct answer and explanation after each question, a score at the end, and a "retry the ones I missed" option.
- **My progress** shows coverage, accuracy and due reviews per category.
- Keyboard shortcuts: A–D or 1–4 to answer, Enter for the next question.

**Admin**
- **Learners:** add a learner (name, email, temporary password), then copy the sign-in details to send them. Click a learner to see their progress by category, rename them, set a new password, disable or re-enable the account, change their role, or reset their progress.
- **Questions:** add categories, bulk-import questions from JSON, add or edit single questions, hide questions without deleting them, and export everything to JSON as a backup.

## Question import format

A JSON list. Categories that don't exist yet are created automatically, and questions that already exist are skipped.

```json
[
  {
    "category": "Networking",
    "question": "Which port does HTTPS use by default?",
    "options": ["21", "80", "443", "8080"],
    "answer": "C",
    "explanation": "Optional. Shown after the learner answers."
  }
]
```

- `answer` can be a letter (`"C"`) or the exact text of the correct option.
- Up to 10 options per question. Prefixes like `A) ` are stripped automatically.
- Options containing "All of the above" or "None of the above" keep their order. All other options are shuffled for each learner.
- `sample-questions.json` is a small example you can import to try the app.

## How it's secured

- **No public sign-up.** An account can only be created for an email the admin has added. The database rejects any other sign-up, even one sent directly to Supabase.
- **Learners can't see each other.** Learners see only their own progress, can't see other accounts, and can't change questions or their own role. These rules are enforced in the database (row-level security), not just hidden in the page.
- **Scores can't be faked.** Answers are checked on the server, so editing the page can't change a score.
- **The secret key stays on the server.** Creating accounts and setting passwords runs in a Supabase Edge Function (`admin-users`) that checks the caller is an active admin. The key in `config.js` is Supabase's *publishable* key, which is designed to be public.

## Files

| File | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The app |
| `config.js` | Supabase project URL and publishable key, app name, option shuffling |
| `sample-questions.json` | Example questions for import |
| `supabase/schema.sql` | Database tables, security rules and functions (already applied, safe to re-run) |
| `supabase/functions/admin-users/index.ts` | Server function for creating accounts and setting passwords (already deployed) |

## Good to know

- **Free Supabase projects pause after about a week with no activity.** If the app stops loading after a quiet spell, open the project in the Supabase dashboard and click **Restore**. Your data is kept.
- To change the app name shown in the header, edit `APP_NAME` in `config.js`.
- Use **Export JSON** on the Questions page now and then to keep a backup of the question bank.
