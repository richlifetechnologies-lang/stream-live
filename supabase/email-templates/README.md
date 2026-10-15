# Stream Live email templates

These two files are the customer-facing emails, written so a new account reads
"Stream Live" and nothing else. They are not served from this repo — Supabase's auth
mail is edited in the dashboard, so this is the paste-in source that keeps the wording
under version control.

## What to paste

Dashboard → project → **Authentication → Sign In / Up → Email templates**.

| Template | Subject line | HTML body |
| --- | --- | --- |
| Confirm signup | `Confirm your Stream Live account` | `confirm-signup.html` |
| Recovery password | `Reset your Stream Live password` | `recover-password.html` |

Each template also has a plain-text box. Put the same one sentence of body there
("Your Stream Live account is created — open the link in this email to confirm it:" /
"Someone asked to reset your Stream Live password:") and **no link**. Printing the
`{{ .ConfirmationURL }}` in the text version is the one way to spell the provider's
address out as plain text, which is exactly what these templates exist to avoid. The
cost is narrow: a recipient whose mail client strips HTML altogether sees the sentence
but nothing to click. Every mainstream client (Gmail, Outlook, Apple Mail, phone mail)
renders the HTML version with its button.

While you are in that screen:

- **Confirm email is currently OFF on this project**, so no signup mail is sent at all
  and a new account works the moment it is created. `confirm-signup.html` only reaches
  anybody if you switch that on. It is not a free change: with confirmation on, Supabase
  refuses password sign-in until the link is opened, so the app's success message
  ("your account works immediately — sign in to continue") becomes a lie and the
  product rule "usable the instant it is created" is replaced. Say the word and that
  copy and the sign-in path get updated with it; until then the template sits ready and
  unsent.
- **Sender name** → `Stream Live`. It is the single thing a customer reads first, and
  by default it is the auth provider's own name.
- **Site URL** (Authentication → URL Configuration) → your own page, e.g.
  `https://richlifetechnologies-lang.github.io/stream-live/`. Where the link lands
  after confirming is your address, not a provider's.

## What these files cannot change

Two things about the mail are structural, and no template edit fixes them:

1. **The link inside the button.** Its host is the project's own API address, so the
   hover preview shows it. The templates here never print that address as text — the
   usual "copy this URL into your browser" fallback line was left out on purpose, and
   the button is labelled with what it does. Removing the host from the link itself
   takes a custom domain on the project (paid plan), not a wording change.
2. **The return address.** `noreply@<project>.supabase.co` is replaced by connecting
   your own SMTP under Authentication → SMTP settings, which needs a domain and its
   DNS records. Until then the display name says Stream Live and the address does not.

Both are one-time dashboard jobs. If you want the sender address to read `@yourdomain`
too, say which domain you own and what the mail service is, and the SMTP settings and
DNS records get written out for you.

## What is enforced in code instead

Whether an address is *shaped* like an address is not an email-template matter, and it
is checked in two places, so neither a customer nor a script can skip it:

- the sign-up screen (`desktop/src/pages/account.tsx`) refuses before it even asks, and
  that is the message a human reads;
- the auth row itself (`supabase/migrations/20261015104000_signup_email_guard.sql`)
  refuses, so an older build or a hand-made request cannot create an account on an
  address that could never receive mail. The database's own wording is not something
  the app prints: the auth service wraps a trigger refusal in its own sentence, and the
  desktop app turns that into a plain "we couldn't create the account".

A correctly spelled address that belongs to nobody is still only detectable by
delivering something to it. That is the one argument for turning **Confirm email** on,
with the cost spelled out above — it is your call, and the templates here are ready
either way.

Separately, the same sign-up call now carries the computer's id, so the free trial
follows the machine instead of the login
(`supabase/migrations/20261015102000_device_bound_trial.sql`): a second account created
on a machine that already carried a trial is granted none.
