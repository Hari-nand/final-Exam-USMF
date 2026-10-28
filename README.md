# USMF Exam Prep

A practice site for the USMF graduation exam tests. The admin creates learner accounts and loads the question bank. Learners drill single topics or sit mock exams built to the official blueprint, and every answer is saved so progress and the improvement curve carry across devices.

- **Website:** hosted on GitHub Pages from this repository (`index.html` at the root).
- **Database and logins:** Supabase project `mcq-practice`.

## What it does

**Learners**
- **Home:** estimated exam score, latest mock exam, accuracy, weakest topics with a one-click drill, and the improvement curve.
- **Practice:** pick whole disciplines or single topics, then a mode:
  - **Smart review:** questions due for review plus new ones first. A correct answer comes back after 1, 3, 7, 14, then 30 days; a wrong one comes back straight away.
  - **Random:** shuffled questions from the selection.
  - **My mistakes:** only questions answered wrongly last time.
  
  Single-answer (CS) questions are checked as soon as an option is picked. Multiple-answer (CM) questions are checked after the learner selects options and presses **Check answer**. Like the real exam, a CM answer counts only if it matches the key exactly; the feedback still shows which options were right, wrong or missed.
- **Mock exam:** 50, 100, 150 or 200 questions drawn at random from the whole bank, split across disciplines by the exam weights (largest-remainder rounding). Optional timer of one minute per question, a question navigator, flags, and answers that survive a page reload. Answers are revealed after submitting, with a score per discipline and a filterable review.
- **Progress:** improvement curve (mock exams solid, topic practice dashed, with a table version), estimated exam score weighted by the blueprint, readiness per discipline and coverage/accuracy per topic.
- Keyboard: A–E or 1–5 to answer, Enter to check / go on; in a mock exam ← → to move and F to flag.

**Admin**
- **Learners:** add a learner (name, email, temporary password) and copy the sign-in details to send. Open a learner to see their full progress and curve, rename them, set a password, disable or re-enable, change role, or reset progress.
- **Questions & blueprint:** edit the discipline weights, bulk-import the question bank from JSON, browse by discipline and topic, edit questions (several correct answers allowed), hide or delete questions, and export everything to JSON.

## Exam blueprint

From *Teste examen absolvire ENG 2026*. Editable on the admin page.

| Profile | Discipline | Share |
|---|---|---|
| Internal medicine | Pneumology | 7% |
| | Cardiology | 10% |
| | Gastroenterology | 10% |
| | Rheumatology | 6% |
| | Nephrology | 2% |
| Pediatrics | Pediatrics | 25% |
| Surgical diseases | Surgery (3rd year) | 5% |
| | Surgery (4th year) | 8% |
| | Surgery (5th year) | 8% |
| | Pediatric surgery | 4% |
| Obstetrics & gynecology | Obstetrics & gynecology | 15% |

## Question import format

A JSON list. Disciplines and topics that don't exist yet are created automatically, and a question already in the same topic with the same options is skipped.

```json
[
  {
    "discipline": "Cardiology",
    "topic": "Arrhythmias",
    "type": "CM",
    "question": "Indicate the ECG characteristics of atrial extrasystole:",
    "options": ["…", "…", "…", "…", "…"],
    "answer": "ABE",
    "explanation": "Optional. Shown after the learner answers."
  }
]
```

- `answer` is the letter or letters of the correct options in the order given (`"B"`, `"ACD"`).
- `type` is `CS` (single) or `CM` (multiple); a key with more than one letter is always treated as `CM`.
- Topic names must be unique across the whole bank.
- Options containing "All of the above" or "None of the above" keep their order. Other options are shuffled per learner, and the key follows the shuffle.
- `sample-questions.json` is a two-question example. The full bank is kept out of this public repository.

## How it's secured

- **No public sign-up.** Accounts can only be created by the admin. The database rejects any other sign-up, even one sent directly to Supabase.
- **Learners can't see each other.** Learners see only their own sessions, answers and progress, and can't change questions or their own role. This is enforced in the database (row-level security).
- **Scores can't be faked.** Every answer is marked on the server against the stored key, and sessions and answers can only be written through those server functions.
- **The secret key stays on the server.** Creating accounts and setting passwords runs in a Supabase Edge Function (`admin-users`) that checks the caller is an active admin. The key in `config.js` is Supabase's *publishable* key, which is meant to be public.

## Files

| File | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The app |
| `config.js` | Supabase URL and publishable key, app name, option shuffling |
| `sample-questions.json` | Example questions for import |
| `supabase/schema.sql` | Base tables, security rules and functions (applied) |
| `supabase/migration_002_exam.sql` | Disciplines, multiple-answer questions, sessions and answer history (applied) |
| `supabase/functions/admin-users/index.ts` | Server function for creating accounts and setting passwords (deployed) |

## Good to know

- **Free Supabase projects pause after about a week with no activity.** If the app stops loading after a quiet spell, open the project in the Supabase dashboard and click **Restore**. Data is kept.
- Use **Export JSON** on the Questions page now and then to keep a backup of the bank.
