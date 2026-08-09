# Email/password auth + roles + security page

Almost all of this request is already live in the project. Verified against the database and code:

| Requested | Current state |
| --- | --- |
| Email/password auth | Live on `/auth` (sign-up + sign-in, plus Google) |
| 1:1 profile table | `user_profiles`, auto-created on signup, RLS scoped to the owner |
| Separate roles table + enum | `user_roles` with `app_role` = admin / operator / member; roles are never stored on the profile |
| `has_role(uuid, app_role)` | Exists, SECURITY DEFINER, `search_path = public`; EXECUTE granted only to `authenticated` and `service_role` (not `anon`, not `PUBLIC`) |
| Security settings table | `user_security_settings` (mfa, hardware_wallet, withdrawal_whitelist, timelock_24h), owner-only RLS; `security_sessions` holds active sessions |
| Audit log | `security_audit_log`, owner-read, insert-only, with a trigger that records every settings change |
| `/security` page | MFA toggle, active sessions with revoke, and the audit log feed |
| No wallet linking | Correct — no wallet fields on these tables |

## The one real gap

The one-time admin bootstrap is still armed. Two triggers on new/confirmed accounts call `grant_admin_for_designated_email()`, which grants `admin` to the hardcoded designated email. The designated admin account already exists and is email-verified, so the bootstrap has served its purpose and should now be retired — while it stays in place, anyone who ever obtains that email address at signup is auto-promoted.

## Change to make

One migration that:

1. Confirms an email-verified `admin` already exists in `user_roles`, and raises an exception (aborting the migration) if not — so the bootstrap is never removed before a real admin exists.
2. Drops the triggers `on_auth_user_created_grant_admin` and `on_auth_user_confirmed_grant_admin` on `auth.users`.
3. Drops the function `public.grant_admin_for_designated_email()`.
4. Writes a `security_audit_log` entry for the admin recording that the bootstrap was retired.

After this, admin can only be granted deliberately through `user_roles`; no signup path can self-promote. Nothing else changes — no app code edits are needed.
