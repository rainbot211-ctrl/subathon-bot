# subathon-bot — the single shared leaderboard

This is the **one** process that reads your Twitch chat and counts it, so every
viewer of the dashboard sees the **same** numbers (instead of each browser
counting on its own). It tallies exactly what the page shows — per-user
messages, active days, peak hours, and emote usage (Twitch + 7TV/FFZ/BTTV) —
saves it to disk so it survives restarts, and serves it as JSON:

```
GET /leaderboard      global totals + top emotes + top 100 users (full stats)
GET /user?login=name  one user's full stats (so search works for anyone tracked)
GET /health           { ok, channel, total, users, uptime }
```

It needs **no Twitch credentials** (anonymous chat read). Profile pictures, 7TV
paints, and badge art are still fetched by the page through your cached
Cloudflare proxy — this bot only owns the message counts.

## It must run 24/7
A subathon board has to keep counting, so host it somewhere **always-on**.
Good options: **Railway**, **Fly.io**, or a small **VPS**. Avoid free tiers that
sleep on idle (e.g. Render's free web service) — if it sleeps, it stops counting.

---

## Deploy on Railway (easiest, ~$5/mo after trial)

1. Put this `subathon-bot` folder in a GitHub repo (or use `railway up` from the
   folder with the Railway CLI).
2. Go to https://railway.app → **New Project** → **Deploy from GitHub repo** (or
   **Empty Project** → drag the folder with the CLI).
3. Railway auto-detects Node, runs `npm install`, then `npm start` (`node bot.js`).
4. Open **Variables** and set:
   - `CHANNEL` = `byukitv`  (lowercase Twitch login of the channel to track)
   - `TZ` = e.g. `America/New_York`  (so "Peak Hour" uses the streamer's timezone)
   - *(optional)* `DATA_FILE` = `/data/data.json` if you attach a Volume (below)
5. **Networking → Generate Domain.** You'll get a URL like
   `https://subathon-bot-production.up.railway.app`. Copy it.
6. *(recommended)* Add a **Volume** mounted at `/data` and set
   `DATA_FILE=/data/data.json` so the tally survives redeploys, not just restarts.

Quick check: open `https://<your-bot-domain>/health` — you should see
`{"ok":true,"channel":"byukitv","total":...}` and, once chat is flowing,
`/leaderboard` returns the JSON.

## Run locally (to test first)

```bash
cd subathon-bot
npm install
CHANNEL=byukitv node bot.js
# then open http://localhost:8080/leaderboard
```

---

## Wire it to the dashboard (two small edits)

**1 — Point your Cloudflare Worker at the bot** (so reads are edge-cached and
scale to a big audience). In `twitch-proxy/wrangler.toml` set:

```toml
[vars]
BOT_ORIGIN = "https://<your-bot-domain>"
```

then redeploy the worker:

```bash
cd twitch-proxy
npx wrangler deploy
```

Your worker now serves the shared board at
`https://byukitv-twitch-proxy.<subdomain>.workers.dev/leaderboard`, cached ~4s.

**2 — Turn on shared mode in the page.** In `index.html`, near the top of the
`<script>`, set `SHARED_API` to that worker URL:

```js
const SHARED_API = "https://byukitv-twitch-proxy.<subdomain>.workers.dev/leaderboard";
```

Save and reload. The page now shows the single shared leaderboard for everyone,
refreshing every few seconds. (Leave `SHARED_API = ""` to go back to the old
per-browser mode.)

> You can point `SHARED_API` straight at the bot's `/leaderboard` for quick
> testing, but for a real launch use the Worker URL — that's what absorbs the
> traffic. The bot itself should not be hammered by every viewer directly.

## Notes
- **Timezone:** day/hour buckets use the bot's clock. Set `TZ` on the host so
  "Most Active Day" / "Peak Hour" reflect the streamer's timezone.
- **Durability:** without a mounted volume, `data.json` survives normal restarts
  but a redeploy on an ephemeral filesystem starts fresh. Use a volume for a
  long subathon.
- **One channel per bot.** To track a different/second channel, run another copy
  with a different `CHANNEL`.
- **Cost:** the bot is one tiny always-on instance (~$5/mo). The page stays on
  Cloudflare Pages (free) and the Worker on the $5/mo plan if you exceed 100k
  requests/day.
