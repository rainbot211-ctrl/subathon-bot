// =============================================================================
// subathon-bot  —  ONE shared leaderboard for the whole audience.
//
// What it does:
//   • Connects ONCE to your Twitch chat (anonymous read, server-side).
//   • Counts every message into a single shared tally: per-user messages,
//     active days, peak hours, and emote usage (Twitch + 7TV/FFZ/BTTV),
//     plus global totals — exactly the stats the leaderboard page shows.
//   • Persists the tally to disk so it survives restarts.
//   • Serves it as a small JSON API the page reads:
//        GET /leaderboard   -> global totals + top emotes + top 100 users (full stats)
//        GET /user?login=x  -> one user's full stats (for searching anyone)
//        GET /health        -> { ok, channel, total, users, uptime }
//
// It needs NO Twitch credentials (anonymous chat read). Profile pictures,
// 7TV paints, and channel badge art are still fetched by the page through your
// cached Cloudflare proxy — this bot only owns the message tallies.
//
// Run it on any always-on Node host (Railway / Render / Fly / a VPS). See README.
//   CHANNEL=byukitv  node bot.js
// =============================================================================

import http from "node:http";
import fs from "node:fs";
import WebSocket from "ws";

const CHANNEL   = (process.env.CHANNEL || "byukitv").toLowerCase();
const PORT      = parseInt(process.env.PORT || "8080", 10);
const DATA_FILE = process.env.DATA_FILE || "./data.json";
const SAVE_MS   = 15000;          // persist to disk every 15s
const FEED_USERS = 100;           // top N users (with full stats) in /leaderboard
const EM_CAP    = 30;             // keep at most this many emotes per user

// ---------- shared state ----------------------------------------------------
const S = {
  channel: CHANNEL, roomId: null, total: 0, startedAt: Date.now(),
  users: new Map(),               // login -> { login, display, n, first, last, color, uid, badgeTag, d:{}, h:[24], em:{} }
  emotes: new Map(),              // name  -> { n, provider, url }
  days: new Map(),                // "YYYY-MM-DD" -> count
  hours: new Array(24).fill(0),
};
const thirdParty = new Map();     // emote token -> { provider, url }  (7TV/FFZ/BTTV)

// ---------- helpers ----------------------------------------------------------
const dayKey = (ts) => { const d = new Date(ts); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const TW_EMOTE_URL = (id) => "https://static-cdn.jtvnw.net/emoticons/v2/" + id + "/default/dark/2.0";

function bumpEmote(name, provider, url) {
  let e = S.emotes.get(name);
  if (!e) { e = { n: 0, provider, url: url || "" }; S.emotes.set(name, e); }
  if (!e.url && url) e.url = url;
  e.n++;
}
function bumpUserEmote(u, name) {
  u.em[name] = (u.em[name] || 0) + 1;
  // keep the per-user map bounded
  const keys = Object.keys(u.em);
  if (keys.length > EM_CAP * 2) {
    const top = keys.sort((a, b) => u.em[b] - u.em[a]).slice(0, EM_CAP);
    const next = {}; for (const k of top) next[k] = u.em[k]; u.em = next;
  }
}

// ---------- tally one chat message ------------------------------------------
function record(tags, text) {
  const login = (tags["login"] || tags["display-name"] || "").toLowerCase() || null;
  if (!login) return;
  const ts = parseInt(tags["tmi-sent-ts"] || Date.now(), 10) || Date.now();
  const k = dayKey(ts), hr = new Date(ts).getHours();

  let u = S.users.get(login);
  if (!u) { u = { login, display: tags["display-name"] || login, n: 0, first: ts, last: ts, color: tags["color"] || null, uid: tags["user-id"] || null, badgeTag: "", d: {}, h: new Array(24).fill(0), em: {} }; S.users.set(login, u); }
  u.n++; u.last = ts;
  if (tags["display-name"]) u.display = tags["display-name"];
  if (tags["color"]) u.color = tags["color"];
  if (tags["user-id"]) u.uid = tags["user-id"];
  if (tags["badges"] != null) u.badgeTag = tags["badges"];
  u.d[k] = (u.d[k] || 0) + 1;
  u.h[hr]++;

  S.total++;
  S.days.set(k, (S.days.get(k) || 0) + 1);
  S.hours[hr]++;
  if (tags["room-id"] && !S.roomId) { S.roomId = tags["room-id"]; loadEmotes(S.roomId).catch(() => {}); }

  // Twitch emotes (from the emotes tag: "id:start-end,start-end/id:start-end")
  const etag = tags["emotes"];
  if (etag) {
    const chars = Array.from(text);
    for (const part of etag.split("/")) {
      if (!part) continue;
      const [id, ranges] = part.split(":");
      if (!ranges) continue;
      const spans = ranges.split(",");
      const [a, b] = spans[0].split("-").map(Number);
      const name = chars.slice(a, b + 1).join("");
      if (!name) continue;
      for (let i = 0; i < spans.length; i++) { bumpEmote(name, "twitch", TW_EMOTE_URL(id)); bumpUserEmote(u, name); }
    }
  }
  // third-party emotes (7TV/FFZ/BTTV) — scan words
  if (thirdParty.size) {
    for (const tok of text.split(/\s+/)) {
      const m = thirdParty.get(tok);
      if (m) { bumpEmote(tok, m.provider, m.url); bumpUserEmote(u, tok); }
    }
  }
}

// ---------- third-party emote sets ------------------------------------------
async function loadEmotes(roomId) {
  const add = (code, provider, url) => { if (code && !thirdParty.has(code)) thirdParty.set(code, { provider, url }); };
  // 7TV
  try { const r = await fetch("https://7tv.io/v3/users/twitch/" + roomId); if (r.ok) { const j = await r.json(); for (const e of (j.emote_set?.emotes || [])) add(e.name, "7tv", "https://cdn.7tv.app/emote/" + e.id + "/2x.webp"); } } catch (_) {}
  try { const r = await fetch("https://7tv.io/v3/emote-sets/global"); if (r.ok) { const j = await r.json(); for (const e of (j.emotes || [])) add(e.name, "7tv", "https://cdn.7tv.app/emote/" + e.id + "/2x.webp"); } } catch (_) {}
  // FFZ
  try { const r = await fetch("https://api.frankerfacez.com/v1/room/id/" + roomId); if (r.ok) { const j = await r.json(); for (const sid in (j.sets || {})) for (const e of (j.sets[sid].emoticons || [])) add(e.name, "ffz", "https:" + (e.urls["2"] || e.urls["1"])); } } catch (_) {}
  // BTTV
  try { const r = await fetch("https://api.betterttv.net/3/cached/users/twitch/" + roomId); if (r.ok) { const j = await r.json(); for (const e of [...(j.channelEmotes || []), ...(j.sharedEmotes || [])]) add(e.code, "bttv", "https://cdn.betterttv.net/emote/" + e.id + "/2x"); } } catch (_) {}
  try { const r = await fetch("https://api.betterttv.net/3/cached/emotes/global"); if (r.ok) { const j = await r.json(); for (const e of j) add(e.code, "bttv", "https://cdn.betterttv.net/emote/" + e.id + "/2x"); } } catch (_) {}
  console.log("[emotes] loaded " + thirdParty.size + " third-party emotes");
}
setInterval(() => { if (S.roomId) loadEmotes(S.roomId).catch(() => {}); }, 30 * 60 * 1000);

// ---------- IRC parsing ------------------------------------------------------
function parseTags(raw) { const t = {}; for (const p of raw.split(";")) { const i = p.indexOf("="); t[p.slice(0, i)] = p.slice(i + 1); } return t; }
function handleLine(line) {
  if (line.startsWith("PING")) { ws.send("PONG :tmi.twitch.tv"); return; }
  let tags = {}, rest = line;
  if (line[0] === "@") { const sp = line.indexOf(" "); tags = parseTags(line.slice(1, sp)); rest = line.slice(sp + 1); }
  if (rest.indexOf("PRIVMSG") === -1) return;
  const msgIdx = rest.indexOf(" :", rest.indexOf("PRIVMSG"));
  const text = msgIdx >= 0 ? rest.slice(msgIdx + 2) : "";
  if (!tags["login"]) { const bang = rest.indexOf("!"); if (bang > 0) tags["login"] = rest.slice(1, bang); }
  record(tags, text);
}

// ---------- Twitch IRC connection (auto-reconnect) --------------------------
let ws = null, reconnectMs = 1000;
function connect() {
  ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ws.on("open", () => {
    reconnectMs = 1000;
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    ws.send("NICK justinfan" + Math.floor(Math.random() * 999999));
    ws.send("JOIN #" + CHANNEL);
    console.log("[irc] connected, joined #" + CHANNEL);
  });
  ws.on("message", (buf) => { for (const line of buf.toString().split("\r\n")) if (line) handleLine(line); });
  ws.on("close", () => { console.log("[irc] closed, reconnecting in " + reconnectMs + "ms"); setTimeout(connect, reconnectMs); reconnectMs = Math.min(reconnectMs * 2, 30000); });
  ws.on("error", (e) => { console.log("[irc] error", e.message); try { ws.close(); } catch (_) {} });
}

// ---------- persistence ------------------------------------------------------
function save() {
  try {
    const snap = {
      v: 1, channel: S.channel, roomId: S.roomId, total: S.total, startedAt: S.startedAt, savedAt: Date.now(),
      hours: S.hours, days: [...S.days.entries()],
      emotes: [...S.emotes.entries()].map(([k, e]) => [k, e.n, e.provider, e.url]),
      users: [...S.users.entries()].map(([k, u]) => [k, u.display, u.n, u.first, u.last, u.color, u.uid, u.badgeTag, u.d, u.h, topEm(u.em)]),
    };
    fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(snap));
    fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
  } catch (e) { console.log("[save] error", e.message); }
}
function topEm(em) { const o = {}; for (const k of Object.keys(em).sort((a, b) => em[b] - em[a]).slice(0, EM_CAP)) o[k] = em[k]; return o; }
function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (d.channel && d.channel !== CHANNEL) { console.log("[load] saved channel differs, starting fresh"); return; }
    S.roomId = d.roomId || null; S.total = d.total || 0; S.startedAt = d.startedAt || Date.now();
    S.hours = (d.hours && d.hours.length === 24) ? d.hours : new Array(24).fill(0);
    S.days = new Map(d.days || []);
    for (const [k, n, pv, url] of (d.emotes || [])) S.emotes.set(k, { n, provider: pv, url: url || "" });
    for (const [k, disp, n, f, l, c, uid, bt, dd, hh, em] of (d.users || []))
      S.users.set(k, { login: k, display: disp, n, first: f, last: l, color: c || null, uid: uid || null, badgeTag: bt || "", d: dd || {}, h: (hh && hh.length === 24) ? hh : new Array(24).fill(0), em: em || {} });
    console.log("[load] resumed: " + S.total + " messages, " + S.users.size + " users");
    if (S.roomId) loadEmotes(S.roomId).catch(() => {});
  } catch (e) { console.log("[load] error", e.message); }
}
setInterval(save, SAVE_MS);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { save(); process.exit(0); });

// ---------- read API ---------------------------------------------------------
function userOut(u) { return { login: u.login, display: u.display, n: u.n, first: u.first, last: u.last, color: u.color, uid: u.uid, badgeTag: u.badgeTag, d: u.d, h: u.h, em: topEm(u.em) }; }
function leaderboard() {
  const top = [...S.users.values()].sort((a, b) => b.n - a.n).slice(0, FEED_USERS).map(userOut);
  // emotes the page needs: global top 60 PLUS every emote any returned user used,
  // so each person's "top 7TV emotes" can be classified even if rare globally.
  const out = new Map();
  for (const [k, e] of [...S.emotes.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 60)) out.set(k, [k, e.n, e.provider, e.url]);
  for (const u of top) for (const nm in u.em) if (!out.has(nm)) { const e = S.emotes.get(nm); if (e) out.set(nm, [nm, e.n, e.provider, e.url]); }
  return { channel: S.channel, roomId: S.roomId, total: S.total, updatedAt: Date.now(), startedAt: S.startedAt, days: [...S.days.entries()], hours: S.hours, emotes: [...out.values()], users: top };
}
function send(res, obj, maxAge) {
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=" + maxAge });
  res.end(JSON.stringify(obj));
}
http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" }); return res.end(); }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/leaderboard") return send(res, leaderboard(), 5);
  if (url.pathname === "/user") { const lg = (url.searchParams.get("login") || "").toLowerCase(); const u = S.users.get(lg); return send(res, u ? userOut(u) : { error: "not found", login: lg }, 15); }
  if (url.pathname === "/health") return send(res, { ok: true, channel: S.channel, total: S.total, users: S.users.size, roomId: S.roomId, uptimeSec: Math.round((Date.now() - S.startedAt) / 1000) }, 0);
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ ok: true, channel: S.channel, endpoints: ["/leaderboard", "/user?login=", "/health"] }));
}).listen(PORT, () => console.log("[api] listening on :" + PORT));

// ---------- go ---------------------------------------------------------------
load();
connect();
