# NaviGO Share trip

The page people see when you share a trip from the NaviGO app: a dark map with your route,
your arrival time, distance and time left, and your live position (shown as your mood emoji or
profile photo), with when it was last updated.

- Your link never changes (`/t/<your id>`). Between trips the page says you're not sharing and shows no location.
- Only your phone can update it (it signs each update with a secret key it keeps).
- Map: Mapbox's dark map when `MAPBOX_TOKEN` (a Mapbox public `pk.` token) is set in Render → Environment; otherwise OpenStreetMap, darkened. Drawn with Leaflet.

## Deploy on Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/nickdee24/navigo-share)

Free plan is fine. Pushing to GitHub redeploys it automatically (`autoDeploy` in `render.yaml`).
On the free plan the site sleeps after 15 minutes with no visitors; while you're sharing, your phone's
updates keep it awake.

## Run locally

```bash
npm start   # http://localhost:3000
```

## API (used by NaviGO)

- `POST /api/share/update` `{ id, key, name, mood, lat, lng, heading, speed, dest: {name, lat, lng}, eta, remainingM, route?: [[lat,lng],…], photo?: base64 jpeg }`
- `POST /api/share/end` `{ id, key, arrived }`
- `GET /api/share/<id>` → what the page shows
