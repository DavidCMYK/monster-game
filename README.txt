
Monster Battler — Deployment Guide
Generated: 2025-10-19 14:06 UTC

Prereqs
- Node.js 18+ and npm
- MySQL/MariaDB (use your WordPress DB or a new DB)
- WordPress admin access

1) Backend
- cd monster_game
- npm init -y
- npm install express ws body-parser
- node server.js
  * Default: http://localhost:3001, WS at ws://localhost:3001/ws
  * Health: GET /api/health

2) Database (Optional at first)
- Create DB and run db_schema.sql (tables mg_effects, mg_bonuses, mg_moves_named, mg_players).
- The demo uses in-memory maps; wire to DB when ready per Admin/Server Architecture Bible.

3) WordPress Plugin
- Copy monster_game/wp_plugin into wp-content/plugins/monster-game
- Activate "Monster Game (Embed Client)"
- Settings → Monster Game: set API and WS endpoints (e.g., http://YOUR_HOST:3001 and ws://YOUR_HOST:3001/ws)
- Create a WordPress page and put the shortcode: [monster_game]

4) Local Dev (without WordPress)
- Open client/index.html in a browser while the Node server is running.
- MGGameConfig auto-points to localhost:3001 for API and WS if on localhost.

Notes
- World chunk size is 256x256 tiles (placeholder visuals).
- Movement uses arrow keys/WASD; chunk transitions handled at edges.
- Replace the demo auth with production auth tied into WordPress if desired.
- See design bibles for the full feature set and extend the placeholder modules accordingly.
