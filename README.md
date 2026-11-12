# Cafe Paris — Staff Attendance Management

A responsive staff attendance application built with HTML, CSS, JavaScript, Node.js, Express and MongoDB Atlas.

## Features

- Shared-password sign-in with an eight-hour secure session.
- Dashboard with today's attendance and monthly totals.
- Add staff members with automatically generated staff IDs.
- Require the password again to add staff or mark a member as former.
- Separate active and former staff directories.
- Set a last working date; historical attendance records remain available.
- Monthly attendance grid with Present, Absent and clear-mark actions.
- Mondays are automatically treated as shop-closed days.
- Attendance cannot be entered for future dates or outside an employee's working period.
- Unmarked working days remain unmarked; they are not automatically counted as absent.
- Monthly employee summaries and CSV export.
- Responsive layout for desktop, tablet and mobile.
- Staff and attendance data stored in MongoDB Atlas.
- Bundled cafe photography from Unsplash.

## Requirements

- Node.js 20.19 or newer (or Node.js 22+)
- npm
- A MongoDB Atlas cluster and database user

## Setup on Windows

1. Create a MongoDB Atlas cluster and a database user with read/write access to the app database.
2. If `.env` does not exist, copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell). Set `MONGODB_URI`, `MONGODB_DB`, a unique `STAFF_MANAGEMENT_PASSWORD` of at least 16 characters, and a separate random `SESSION_SECRET` of at least 32 characters.
3. Configure Atlas Network Access to allow the machine running this app. Do not commit `.env`.
4. Open PowerShell in the project folder and run:

   ```powershell
   npm install
   npm run check
   npm start
   ```

5. Open <http://localhost:3000>.

Generate a session secret with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`; set it directly in `.env` and do not share or commit it.

The existing local SQLite file is not imported. The Atlas database starts empty; the old `data/` files are left untouched.

## Deploy to Vercel

```bash
npm run check
```

Import the repository into Vercel with the Root Directory set to the repository root (not `public/`) and leave the Output Directory unset. The included `vercel.json` builds explicit Node.js functions from `api/` and static assets from `public/`. Add these environment variables in the Vercel project settings for Production (and Preview if needed):

- `MONGODB_URI` — the Atlas connection string.
- `MONGODB_DB` — the database name, for example `cafe_paris`.
- `STAFF_MANAGEMENT_PASSWORD` — a unique secret of at least 16 characters.
- `SESSION_SECRET` — a different random secret of at least 32 characters for signing sessions.
- `TRUST_PROXY=true` — enables correct client IP handling behind Vercel's proxy.

Deploy, then check `/api/health`. Atlas must allow connections from the deployment. Prefer a fixed egress IP or private network integration where available; if using a broad Atlas IP allowlist, use a dedicated database user with only the required database permissions and a strong password. Never put Atlas credentials or the staff password in source control.

For a regular Node.js host, use `npm install` followed by `npm start`; set the same environment variables in the host dashboard. The server listens on the host-provided `PORT`.

## Access and privacy

The shared staff management password is required to sign in and is requested again to add staff or mark a member as former. Attendance and reports are available to signed-in users. Sessions expire after eight hours. This is a shared-password system, not individual accounts or role-based access; use it only for trusted managers and always use HTTPS when deployed.

## Attendance rules

- Mondays are shop-closed and cannot receive attendance marks.
- No mark can be entered before the joining date or after the last working date.
- Future dates cannot be marked.
- A blank working day remains unmarked; it is not assumed to be absent.
- Reports count only explicit Present and Absent marks. Eligible Mondays are calculated for the employee's employment period.

## Data and backups

Use MongoDB Atlas backups or scheduled exports to back up the live database. Store backups securely. Former staff are retained with their attendance history; the app does not permanently delete staff records.

## Deployment note

The app is configured for Atlas-backed deployment. Protect the deployment with HTTPS, keep environment values private, use least-privilege Atlas credentials, configure trusted proxy handling, and maintain regular backups. Multiple managers on separate devices can use the same deployment and shared Atlas database.

## Official attendance start date
- Attendance entry, monthly reports, and CSV exports begin on **10 December 2026**.
- Dates before 10 December 2026 cannot be marked, including through the API.
- Staff profiles may be prepared before launch; planned joining dates are supported.
- The attendance and report screens default to December 2026 until the launch date.
