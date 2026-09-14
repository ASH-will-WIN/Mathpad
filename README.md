# MathPad

MathPad is a local-first discrete-math notebook with editable inline and display math, Markdown-style formatting, lists, proof blocks, and system/light/dark themes.

## Run locally

```bash
pnpm install
pnpm dev
```

The app runs at `http://localhost:3000` by default.

## Verify a production build

```bash
pnpm build
```

## Deploy with Vercel

Push this repository to GitHub, GitLab, or Bitbucket, then import it into Vercel. Use Node.js 22 or newer. If Vercel asks for project settings, use:

- Build command: `NITRO_PRESET=vercel pnpm run build:vercel`
- Install command: `pnpm install`

The included `vercel.json` selects the Vercel/Nitro build path automatically.

## Storage and Neon sync

MathPad saves to the browser's IndexedDB first, so typing stays fast and the
editor continues to work offline. When a Neon database is configured, the app
also syncs notes in the background through `/api/notes`.

To enable cloud sync:

1. Create a Neon Postgres project and copy its pooled connection string.
2. Add it to your local `.env.local` file:

   ```bash
   DATABASE_URL=postgresql://...
   ```

3. Add the same `DATABASE_URL` as an environment variable for the Vercel
   Production and Preview environments, then redeploy.

The API creates the `mathpad_notes` table automatically on its first request.
The database stores the editor's structured JSON so lists, proof blocks, and
editable math round-trip exactly. IndexedDB remains the local fallback when
Neon is unavailable or not configured. A future backup adapter can use this
same storage boundary without changing the editor.

Cloud sync is intentionally a single shared workspace for now; there are no
MathPad accounts or collaboration permissions.
