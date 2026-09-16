# Demo mode design

## Goal

Provide a frontend-only demo workspace that lets the team develop and review MailExpert's mail interface without configuring OAuth, IMAP, SMTP, or live accounts.

## Activation

`VITE_DEMO_MODE=true` is a build-time frontend flag. It is disabled by default. When enabled, the app bypasses the sign-in screen, enters as a fixed administrator user, and all frontend API calls use local data. No demo request may reach `/api` or a mail provider.

## Architecture

`frontend/src/demo/index.js` owns demo state and exports `demoRequest(method, path, body)`. `frontend/src/utils/api.js` delegates its existing private request function to that adapter only when `isDemoMode` is true, preserving the public `api` object and every production caller. `App.jsx` reads the same mode flag to skip the server auth bootstrap and initialize the existing Zustand store with the demo user and preferences.

The adapter owns two realistic shared mailboxes, folders, unread counts, messages, message bodies, contacts, and an in-memory draft list. It returns the same response shapes consumed by the existing views. Mutating mail endpoints update its state so read/unread, star, archive, delete, move, spam, and draft flows remain interactive until page reload. Unsupported settings and integration endpoints return safe empty data rather than contacting the backend.

## Scope

- Two populated mailboxes with Gmail and shared-team examples.
- Inbox, sent, archive, spam, trash, and project-folder navigation.
- Search, message reading, threads, stars, read state, bulk actions, move/archive/delete/spam, compose draft/save/send simulation, and contacts.
- A visible "Demo" badge so screenshots cannot be confused with live mail.
- A Docker build argument and `.env.example` entry for the flag.

## Non-goals

- Persisting demo changes across reloads.
- Connecting to real accounts, sending real mail, WebSocket simulation, OAuth, AI generation, or completing administrative configuration forms.
- Changing production API contracts or backend routes.

## Validation

Unit tests prove flag parsing and in-memory message mutations. A production build remains unchanged when the flag is absent. A demo build loads the mail workspace, returns local messages, and does not issue API requests.
