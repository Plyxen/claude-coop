# Hub API

JSON over HTTP. Every `/v1/` request needs `Authorization: Bearer <token>`. Requests also count as the member's presence (`online` on the board, and a `member_online` event after 90 seconds away), unless they send `X-Coop-Presence: off`, as the CLI does.

Errors come back as `{"error": "...", "code": "..."}` with a fitting status code. The `code` stays stable, and the sentence may change. Every response has an `x-request-id` header to look for in the audit log.

| Status | Codes |
| --- | --- |
| 400 | `bad_request`, `request_id_required`, `stale_request` |
| 401 | `unauthorized`, `token_expired` |
| 403 | `forbidden`, `approval_setup_required`, `approval_required`, `approval_invalid` |
| 404 | `not_found` |
| 409 | `conflict`, `replay` |
| 410 | `expired` |
| 413, 414 | `too_large` |
| 429 | `rate_limited`, `approval_locked`, with a `Retry-After` header |
| 500 | `internal`, with a `request_id`. Details stay in the hub's log |

A refused token can get 429 rather than 401 once its source has failed too often in the last minute. It's refused either way, and a valid token from the same source still works. The [configuration reference](configuration.md#fixed-hub-limits) lists the limits.

## Request ids

A request that changes something should send:

- `X-Coop-Request-Id`: unique for this request, 8 to 64 letters, digits, `-` or `_`
- `X-Coop-Timestamp`: milliseconds since the epoch, within 5 minutes of the hub's clock

A repeat of the same id, from the same member, within a day, doesn't run again: it gets the first answer back with `X-Coop-Replayed: 1`. If the first request failed, the id can be reused. **Sensitive requests** (`/v1/members`, `/v1/tokens`, `/v1/approvals` and `/v1/permissions/verdict`) must send both headers, and a repeat gets `409 replay`, since their answers can hold a token and aren't stored. Other changes work without them, for older clients.

## Routes

| Method and path | Who | What |
| --- | --- | --- |
| `GET /health` | anyone | `{ok, service}`, no token needed |
| `GET /v1/me` | all | `{name, role, hub, version, lead, latest_event_id, token: {id, label, expires_at}}` |
| `GET /v1/board` | all | Members (with `online`, `last_seen`, `working_on`), active tasks, the last 5 done, and the last 15 visible events. The lead also gets `pending_permissions` and `security_alerts` |
| `GET /v1/events?after=ID&limit=N` | all | Events after `ID` visible to you, not counting your own, plus the `cursor` to pass next time, and `latest_event_id` |
| `GET /v1/tasks?status=S&limit=N` | all | Tasks, newest first |
| `GET /v1/tasks/:id` | all | `{task, history}` |
| `POST /v1/tasks` | lead | Create: `{title, details?, to?, scope?, priority?, branch?}` |
| `POST /v1/tasks/:id/:action` | depends | See below. Body: `{note?, to?, branch?, pr_url?}` |
| `POST /v1/messages` | lead, worker | `{text, to?, task_id?}`. `to` is a member name, `"lead"`, or empty for everyone |
| `POST /v1/members` | lead | Invite: `{name, role?, device?, approval_key?}`. Returns `{name, role, token, token_id, rotated, expires_at}`. `role` is `worker` or `observer`. `device` adds a token and leaves the others working. Otherwise, inviting an existing member replaces their tokens. `approval_key` is needed once a passphrase is set |
| `DELETE /v1/members/:name` | lead | Remove someone: their tokens and open requests stop, and held tasks go back to the pool |
| `POST /v1/permissions` | worker | Relay a permission prompt: `{request_id, tool_name, description, input_preview, cwd?}`. Returns `{id, expires_at, risk}`, or `{duplicate: true, expires_at}` for a resend while it's open. The hub works out the task and the risk label itself |
| `GET /v1/permissions?status=S&limit=N` | lead, worker | `pending` (default), `allowed`, `denied`, `expired`. `pending` means no answer came through the hub: one given on the worker's PC isn't reported. Workers see their own |
| `POST /v1/permissions/verdict` | lead | `{worker, request_id, behavior, approval_key?}`. `behavior` is `allow` or `deny`. `allow` needs `approval_key`. Answers work once |
| `GET /v1/tokens?member=NAME` | all | Token metadata, never hashes. The lead sees everyone's. Others see their own |
| `POST /v1/tokens/rotate` | worker, observer | Replace the token this request used. Returns `{token, id, expires_at}` |
| `DELETE /v1/tokens/:id` | owner, lead | Revoke one token |
| `POST /v1/tokens/revoke-all` | owner, lead | `{member?}`. Returns `{member, revoked}` |
| `GET /v1/approvals` | lead | `{configured, salt, kdf, set_at}`, for deriving the key |
| `POST /v1/approvals/setup` | lead | `{key, salt, kdf, previous_key?}`. `previous_key` is needed to change one that's set |
| `GET /v1/audit?after=ID&limit=N&type=T` | lead | The audit log, newest first |

The lead token can't be rotated or revoked through the API, since it comes from the hub's configuration.

## The approval key

The client turns the passphrase into `approval_key` with scrypt, using the `salt` and `kdf` from `GET /v1/approvals`, and sends the result as 64 hex characters. The hub stores only its SHA-256. The passphrase itself never leaves the PC. `coop approve` and `coop approvals setup` do this for you.

## Task actions

| Action | Who | From | To | Note |
| --- | --- | --- | --- | --- |
| `claim` | lead, worker | open, or assigned to you | in_progress | |
| `progress` | assignee or lead | assigned, in_progress, blocked | in_progress | required |
| `block` | assignee or lead | assigned, in_progress | blocked | required |
| `submit` | assignee or lead | in_progress, blocked | review | required (the summary); `branch`, `pr_url` optional |
| `release` | assignee or lead | assigned, in_progress, blocked | open | |
| `approve` | lead | review | done | |
| `changes` | lead | review, done | in_progress | required (the feedback) |
| `assign` | lead | any active | assigned (with `to`) or open | |
| `cancel` | lead | any active | cancelled | |
| `reopen` | lead | done, cancelled | assigned (with `to`) or open | |
| `comment` | lead, worker | any | unchanged | required |

`branch` has to be a plain branch name: letters, digits and `. _ / -`, starting with a letter or digit, and not a protected one. `pr_url` has to be plain https, with no credentials in it.

## Events

`{id, ts, type, actor, actor_role, target, task_id, text, data}`. `target` is null for events everyone may see, or a member name. Others see events with no target or targeted at them; the lead sees all. Task events carry the task's `title`, `status`, `assignee`, `priority`, `scope`, `branch` and `pr_url` in `data`, plus `previous_status` and `previous_assignee`. `actor` and `actor_role` come from the token (or, for alerts, `hub` and `system`), never from the request.

Types: `member_online`, `member_invited`, `member_token_rotated`, `member_removed`, `task_created`, `task_assigned`, `task_claimed`, `task_progress`, `task_blocked`, `task_submitted`, `task_approved`, `task_changes_requested`, `task_released`, `task_cancelled`, `task_reopened`, `task_comment`, `message`, `permission_request`, `permission_verdict`, `security_alert`.

## Audit log entries

`{id, ts, type, actor, actor_role, target, request_id, source, result, detail}`. `source` is a short hash of the client's address. Nothing here holds a token, a key or a request body.

Types: `auth_success` (after being away), `auth_failure`, `access_denied`, `input_rejected`, `rate_limited`, `token_created`, `token_rotated`, `token_revoked`, `tokens_revoked_all`, `member_added`, `member_removed`, `role_changed`, `task_created`, `task_claimed`, `task_assigned`, `task_approved`, `task_cancelled`, `permission_requested`, `permission_approved`, `permission_rejected`, `permission_stale_answer`, `approval_failed`, `replay_detected`, `secret_redacted`, `security_config_changed`, `security_alert`.
