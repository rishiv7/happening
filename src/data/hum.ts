import type { FeedItem, WeatherNow } from '../types'
import { placeById } from './geo'

// =============================================================================
// Hum store adapter.
// The Grok Bot fleet writes one record per place into a store. This file reads
// that store and converts it into the shapes useLiveData() already consumes.
// Nothing else in the app needs to know the store exists.
//
// Configure with two env vars (see .env.example):
//   VITE_HUM_URL  full URL that returns HumPlace[] as JSON
//   VITE_HUM_KEY  optional; sent as `apikey` header (Supabase anon key)
// With no VITE_HUM_URL the adapter reads /hum-snapshot.json from /public so the
// app runs on the last exported snapshot.
// =============================================================================

export interface HumPlace {
  id: string
  name: string
  lat: number
  lng: number
  city?: string
  updated_at?: string
  record: {
    now?: { t?: string; title: string; source?: string }[]
    upcoming?: { when: string; title: string; source?: string; url?: string; end?: string }[]
    social?: { net?: string; handle?: string; text: string; ts: string; engagement?: number; url?: string }[]
    live?: {
      weather?: { temp?: number; cond?: string; wind?: string; hour?: string; source?: string }
      traffic?: { level?: string; note?: string; as_of?: string }
      webcam?: { name?: string; url?: string }
    }
    volume?: { score?: number; band?: string; explanation?: string }
    summary?: string
    reviews?: { rating?: number | null; count?: number }
    anomaly?: boolean
  }
}

/** Store id -> app Place id. Add a line here whenever the bots name a place differently. */
const ID_MAP: Record<string, string> = {
  'zilker-park': 'zilker',
  'q2-stadium': 'q2',
  'rainey-street': 'rainey',
  'the-domain': 'the-domain', // not seeded in places.ts yet; items still render by lat/lng
}
export const toAppPlaceId = (storeId: string) => ID_MAP[storeId] ?? storeId

// Default live store: hum-live.json on the repo's `live-data` branch, which the
// Grok Bot fleet rewrites after every curator run. Override with VITE_HUM_URL.
const LIVE_BRANCH_URL = 'https://raw.githubusercontent.com/Yaishnavi/happening/live-data/hum-live.json'
const STORE_URL = (import.meta.env.VITE_HUM_URL as string | undefined) || LIVE_BRANCH_URL
const STORE_KEY = import.meta.env.VITE_HUM_KEY as string | undefined
const SNAPSHOT_URL = '/hum-snapshot.json'

export async function fetchHum(signal?: AbortSignal): Promise<{ places: HumPlace[]; source: 'live' | 'cached' }> {
  if (STORE_URL) {
    try {
      // raw.githubusercontent caches for ~5 min; the query param nudges the CDN to revalidate.
      const url = STORE_URL.includes('raw.githubusercontent.com') ? `${STORE_URL}?t=${Math.floor(Date.now() / 60_000)}` : STORE_URL
      const r = await fetch(url, { signal, headers: STORE_KEY ? { apikey: STORE_KEY, Authorization: `Bearer ${STORE_KEY}` } : {} })
      if (r.ok) return { places: normalize(await r.json()), source: 'live' }
    } catch {
      /* fall through to snapshot */
    }
  }
  const r = await fetch(SNAPSHOT_URL, { signal })
  if (!r.ok) throw new Error(`snapshot ${r.status}`)
  return { places: normalize(await r.json()), source: 'cached' }
}

/** Accept either a bare array or a {data: [...]} / {places: [...]} wrapper. */
function normalize(json: unknown): HumPlace[] {
  if (Array.isArray(json)) return json as HumPlace[]
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>
    for (const k of ['data', 'places', 'rows']) if (Array.isArray(o[k])) return o[k] as HumPlace[]
  }
  return []
}

const DEFAULT_EVENT_MIN = 120

/** record.upcoming[] -> FeedItem kind 'event'. Tabs are re-derived by retabEvents() in feed.ts. */
export function humEvents(places: HumPlace[], now = Date.now()): FeedItem[] {
  const items: FeedItem[] = []
  for (const p of places) {
    const appId = toAppPlaceId(p.id)
    const place = placeById(appId)
    for (const u of p.record.upcoming ?? []) {
      const start = Date.parse(u.when)
      if (Number.isNaN(start)) continue
      const end = u.end ? Date.parse(u.end) : start + DEFAULT_EVENT_MIN * 60_000
      if (end < now - 60 * 60_000) continue
      items.push({
        id: `hum-ev-${p.id}-${hash(u.title + u.when)}`,
        kind: 'event',
        tab: now >= start && now <= end ? 'live' : 'upcoming',
        placeId: place?.id,
        title: u.title,
        subtitle: [p.name, u.source].filter(Boolean).join(' · '),
        time: new Date(start).toISOString(),
        endTime: new Date(end).toISOString(),
        lat: place?.lat ?? p.lat,
        lng: place?.lng ?? p.lng,
        image: place?.image,
        url: u.url,
        source: u.source ?? 'Hum calendar bot',
      })
    }
  }
  return items
}

/** record.social[] -> FeedItem kind 'social'. */
export function humSocial(places: HumPlace[]): FeedItem[] {
  const items: FeedItem[] = []
  for (const p of places) {
    const appId = toAppPlaceId(p.id)
    const place = placeById(appId)
    for (const s of p.record.social ?? []) {
      const t = Date.parse(s.ts)
      if (Number.isNaN(t)) continue
      items.push({
        id: `hum-soc-${p.id}-${hash(s.text + s.ts)}`,
        kind: 'social',
        tab: 'social',
        placeId: place?.id,
        title: s.text,
        subtitle: s.handle ? (s.handle.startsWith('@') ? s.handle : `@${s.handle}`) : p.name,
        time: new Date(t).toISOString(),
        lat: place?.lat ?? p.lat,
        lng: place?.lng ?? p.lng,
        url: s.url,
        source: s.net === 'IG' ? 'Instagram' : 'X',
      })
    }
  }
  return items
}

/**
 * City weather from the store. The sensors bot writes one NWS hour per place;
 * we take the freshest one and expose it as WeatherNow. `hourly` is empty unless
 * the bot writes it, so the sidebar's "by 9pm" hint falls back gracefully.
 */
export function humWeather(places: HumPlace[], fallback?: WeatherNow): WeatherNow | undefined {
  let best: { temp: number; cond: string; wind?: string; hour?: string } | undefined
  let bestT = -Infinity
  for (const p of places) {
    const w = p.record.live?.weather
    if (!w || typeof w.temp !== 'number') continue
    const t = Date.parse(w.hour ?? p.updated_at ?? '') || 0
    if (t > bestT) {
      bestT = t
      best = { temp: w.temp, cond: w.cond ?? '', wind: w.wind, hour: w.hour }
    }
  }
  if (!best) return fallback
  return {
    tempF: best.temp,
    shortForecast: best.cond,
    icon: fallback?.icon,
    windSpeed: best.wind,
    hourly: fallback?.hourly ?? [],
    updatedAt: new Date(bestT > 0 ? bestT : Date.now()).toISOString(),
  }
}

/** Per-place activity, for a heat layer or the place detail. Keyed by app Place id. */
export interface HumPlaceState {
  score: number
  band: string
  summary?: string
  traffic?: { level?: string; note?: string }
  webcam?: { name?: string; url?: string }
  anomaly: boolean
}
export function humPlaceState(places: HumPlace[]): Record<string, HumPlaceState> {
  const out: Record<string, HumPlaceState> = {}
  for (const p of places) {
    out[toAppPlaceId(p.id)] = {
      score: p.record.volume?.score ?? 0,
      band: p.record.volume?.band ?? 'Quiet',
      summary: p.record.summary,
      traffic: p.record.live?.traffic,
      webcam: p.record.live?.webcam,
      anomaly: !!p.record.anomaly,
    }
  }
  return out
}

function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
