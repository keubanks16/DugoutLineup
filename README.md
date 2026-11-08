# GS Baseball Dugout

Game-day dugout clipboard: batting order, pitch counts, bullpen timers, defense on a field diagram, a substitution plan (rotations, locked spots, pitching plan, Fair auto-fill) and live field updates.

- **App:** GitHub Pages (`index.html`) at https://keubanks16.github.io/DugoutLineup/
- **Sync server:** Cloudflare Worker + Durable Object (`worker/worker.js`, `wrangler.jsonc`) at https://dugoutlineup.kollinmeubanks.workers.dev

## One-time setup (from your phone)
1. Cloudflare dashboard → Workers & Pages → Create → **Import a repository** → pick `keubanks16/DugoutLineup` → Deploy. Every push to `main` redeploys it.
2. Open the app → Setup → **Create admin password**. That phone is the admin. Every other phone is view only until it signs in with that password.

## How it works
- The admin's changes save to the cloud and show on every device within a few seconds.
- 📣 **Send update** (Field tab, full-screen field, Game tab) pops a big FIELD UPDATE button on every device. With *Auto-send field updates* on (in the Substitution plan), it goes out by itself when the inning changes.
