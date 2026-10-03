# NEXVO

NEXVO is a mobile-first Arabic messaging interface with a same-origin Node.js API and a SQLite database.

## Requirements

- Node.js 22.13 or newer (the built-in SQLite module is used).
- Copy `.env.example` to `.env`, set a unique administrator password (at least 14 characters), and replace `SESSION_SECRET` with at least 32 random characters.
- The password previously shared in chat must not be reused. It was exposed; choose a new unique password.

Generate a session secret with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Start the app with `npm start`, then open <http://127.0.0.1:3000>. The administrator email and password are provisioned from environment variables and are never embedded in browser code. The database and uploaded media are stored in `.data/`, which is excluded from version control.

For deployment, terminate HTTPS at a trusted reverse proxy, set `NODE_ENV=production` and `SESSION_COOKIE_SECURE=true`, use a unique secret in the deployment secret manager, and back up the database and uploaded media together.

## Current server-backed features

- Profile registration with a phone number, username, password, and optional profile image.
- Passwords hashed with Node's scrypt; opaque, HttpOnly, SameSite session cookies backed by SQLite.
- Environment-provisioned administrator sign-in, user directory and account status/verification controls.
- Persistent brand settings and image assets for the app logo, app icon, favicon, default avatar, and Open Graph image.
- Administrative audit log.

Stories, chat drafts, and calls in the front-end prototype are not multi-user services. In particular, live messaging, real phone verification, media transcoding/resumable uploads, WebRTC, groups, and end-to-end encryption require additional backend services and are not represented as working features.
