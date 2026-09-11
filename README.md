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

Math notes are currently stored in the browser's IndexedDB on each device.
