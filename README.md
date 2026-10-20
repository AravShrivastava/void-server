# Void Striker 2 co-op server

The game's multiplayer needs this server. The HTML file cannot host rooms by itself, which is why
multiplayer showed **UNAVAILABLE** and never reached CrazyGames.

## 1. Try it locally (2 minutes)
```
npm install
npm start            # http://localhost:8080 serves the game from ./public/index.html
```
Open `http://localhost:8080` in two browser windows. In window 1 press **PLAY WITH FRIENDS**, copy the
squad code, then **Join room** in window 2. On localhost no URL setting is needed.

## 2. Host it (needs HTTPS and WebSocket support)
Any Node host works: Render, Railway, Fly.io, a VPS behind Caddy/nginx. Start command: `npm start`.
A `Dockerfile` is included. Health check: `GET /health`.

Environment variables (all optional):
- `PORT` – default 8080 (hosts set this for you)
- `ALLOWED_ORIGINS` – comma list, default `*`. Tighten to your game origins once it works.
- `CG_PUBLIC_KEY` – CrazyGames public key (PEM). With it, signed-in CrazyGames users keep a stable
  account id; without it everyone is a guest (names from the token are display-only).
- `GAME_FILE` – path of the game HTML to serve at `/`.

## 3. Point the game at it
```
node set-server-url.js void_striker_final.html https://your-server.example.com
```
This writes `multiplayerUrl` into the game's `VOID_CONFIG` and creates `void_striker_final.mp.html`.
Upload that file as your CrazyGames build, then test in the CrazyGames **Preview** with two accounts:
- Hangar > PLAY WITH FRIENDS creates a squad and marks you joinable (`updateRoom`).
- The Friends drawer shows Invite/Join; joining while in game uses the join-room listener.
- Launching from the Multiplayer landing page (`isInstantMultiplayer`) creates a squad immediately.

## Notes
- State is in memory. A restart ends open squads and clears pending rewards. Add a database if you
  need persistence.
- Room codes are 16 hex characters. Squads hold 5 players. Late joiners spectate until the next round.
- One free-tier instance handles many small squads; each live room costs about 20 snapshots/second.
