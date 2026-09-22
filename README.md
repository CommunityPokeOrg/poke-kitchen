# 🌴 Poke Kitchen

A polished, autonomous 2D top-down virtual kitchen starring **Poke** — a cute minimalist palm-tree chef who runs his own shift.

**Live demo:** https://communitypokeorg.github.io/poke-kitchen/

## What's inside

- **Autonomous/Bot Mode (default)** — Poke picks tickets off the rail, walks between stations with smooth interpolated movement, performs each recipe step with visible cooking animations, plates the dish, and serves it. Fully hands-free.
- **Manual Mode** — click the floor to walk, click a station to use it, click a queued ticket to start it. The rail stays shared either way.
- **Six stations** — Cutting Board/Prep, Stove/Grill, Fryer (120kg batches · fry sauce pH 5.8), Taylor C602 (soft-serve & shakes — gets routine lubrication), Plating Counter, and the Order Ticket Rail.
- **Five recipes** — Poke Smash Burger, 120kg Hot Fries, Compute Broth, Banana Bread, C602 Shake.
- **Live ticket queue + kitchen log** — every action is timestamped and narrated.
- **Shared real-time order rail** — no backend, no keys. Orders are published over **MQTT.js via secure WebSockets** (`wss://broker.hivemq.com:8884/mqtt`, falling back to `wss://broker.emqx.io:8084/mqtt`) on:
  - `communitypoke/kitchen/orders` — new tickets, merged safely by order id (no duplicates)
  - `communitypoke/kitchen/state` — heartbeats, visitor count, and sync-on-join so late visitors see the current rail
  - Connection status is shown in the header; when offline or disconnected the app falls back to a purely local simulation.

## Running locally

It's a static site — no build step.

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deployment

Deployed to **GitHub Pages** via GitHub Actions (`.github/workflows/pages.yml`): every push to `main` uploads the site with `actions/upload-pages-artifact` and publishes with `actions/deploy-pages`.

## Stack

Vanilla HTML5 canvas + CSS + JS. MQTT.js from jsDelivr CDN. Zero dependencies, zero build.
