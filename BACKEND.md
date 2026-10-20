# Backend: the Hum store

Happening reads live data from a store that a Grok Bot fleet keeps up to date. The UI never calls scrapers directly. The adapter is `src/data/hum.ts`; the swap point is `src/data/useLiveData.ts`.

## Where each layer comes from

| Layer | Source | Fallback |
|---|---|---|
| Events (Live / Upcoming) | Hum store, `record.upcoming[]` | `public/hum-snapshot.json`, then mock |
| Social | Hum store, `record.social[]` | snapshot, then mock |
| Weather | Hum store, freshest `record.live.weather` | snapshot, then mock |
| Traffic incidents | City of Austin open data, read by the browser (`src/data/public.ts`) | mock |
| Cameras | City of Austin open data + cctv.austinmobility.io | mock |
| Sun / bats | local suncalc | none needed |

The sidebar's source pills show `live`, `cached` (snapshot or last good value) or `error` per layer.

## Go live

Create `.env.local`:

```
VITE_HUM_URL=https://<project>.supabase.co/rest/v1/places?select=id,name,lat,lng,city,record,updated_at
VITE_HUM_KEY=<supabase anon key>
```

Any URL that returns the array below works (Supabase REST, a public JSON file, a gist raw URL).

**Default, no config:** the app reads `hum-live.json` from the `live-data` branch of the Yaishnavi/happening fork (where the bot fleet has write access)
(`https://raw.githubusercontent.com/Yaishnavi/happening/live-data/hum-live.json`). The bot fleet
commits a fresh copy there after every curator run through the GitHub Contents API. GitHub's raw CDN
caches for up to 5 minutes, so "live" is a few minutes behind. If that URL fails, the app falls back to
`public/hum-snapshot.json`. Replace that file with the latest export before the demo.

## Store record (what the bots write, one row per place)

```ts
{
  id: string,            // see ID_MAP in src/data/hum.ts; ideally matches src/data/places.ts
  name: string, lat: number, lng: number, city: string,
  updated_at: string,    // ISO
  record: {
    upcoming: { when: string /* ISO */, title: string, source?: string, url?: string, end?: string }[],
    social:   { ts: string /* ISO */, net: "X" | "IG", handle: string, text: string, url?: string, engagement?: number }[],
    now:      { t: string, title: string, source: string }[],
    live: {
      weather: { temp: number, cond: string, wind?: string, hour?: string, source?: string },
      traffic: { level: "Peak"|"Busy"|"Steady"|"Quiet", note: string, as_of: string },
      webcam:  { name: string, url: string }
    },
    volume:  { score: number /* 0-100 */, band: "Loud"|"Buzzing"|"Humming"|"Quiet", explanation: string },
    summary: string,
    reviews: { rating: number | null, count: number },
    anomaly: boolean
  }
}
```

`src/data/hum.ts` exposes `humPlaceState()` with `score`, `band`, `summary`, `traffic` and `webcam` per app place id. `useLiveData()` returns it as `placeState`; wire it into the heat layer and PlaceDetail when ready.

## Place ids

The bots use `zilker-park`, `q2-stadium`, `rainey-street`, `the-domain`; the app uses `zilker`, `q2`, `rainey` and has no Domain yet. `ID_MAP` in `hum.ts` bridges this. Events for a store place the app doesn't seed still render on the map by lat/lng, just without a place link.
