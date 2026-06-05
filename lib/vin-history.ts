// lib/vin-history.ts
// Server-only. Decodes factory specs (NHTSA) and attempts to pull public
// auction/history data via a search connector (SerpAPI or Google CSE).
//
// Honesty rules enforced here:
//  - No field is ever fabricated. A field is set ONLY if it was actually
//    parsed from a real source (search result or fetched source page).
//  - Mileage is never guessed. If no mileage is parsed -> null.
//  - No VINs or expected results are hardcoded anywhere in this file.
//  - Exactly one source/search link is returned (sourceUrl).

export type VinDecode = {
  year: string | null
  make: string | null
  model: string | null
  trim: string | null
  bodyClass: string | null
  driveType: string | null
  engine: string | null
  fuelType: string | null
  plantCountry: string | null
  raw: Record<string, string>
}

export type AuctionRecord = {
  vehicle: string | null
  mileage: string | null // e.g. "191 mi / 307 km"
  mileageMiles: number | null
  auctionRecords: number | null
  photosFound: number | null
  primaryDamage: string | null
  secondaryDamage: string | null
  saleDocument: string | null
  loss: string | null
  startCode: string | null
  seller: string | null
  location: string | null
  lot: string | null
}

export type SourceRecord = {
  sourceName: string | null
  sourceUrl: string | null
}

export type VinLookupResult = {
  vin: string
  decode: VinDecode
  auctionRecord: AuctionRecord
  sourceRecord: SourceRecord
  connector: 'serpapi' | 'google_cse' | null
}

type SearchHit = { title: string; snippet: string; link: string }

const VALID_VIN = /^[A-HJ-NPR-Z0-9]{17}$/i

export function isValidVin(vin: string): boolean {
  return VALID_VIN.test((vin || '').trim())
}

function emptyAuctionRecord(): AuctionRecord {
  return {
    vehicle: null,
    mileage: null,
    mileageMiles: null,
    auctionRecords: null,
    photosFound: null,
    primaryDamage: null,
    secondaryDamage: null,
    saleDocument: null,
    loss: null,
    startCode: null,
    seller: null,
    location: null,
    lot: null,
  }
}

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit) {
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(id)
  }
}

// ---------------------------------------------------------------------------
// 1) Factory spec decode (preserves existing NHTSA decode behaviour)
// ---------------------------------------------------------------------------
export async function decodeVin(vin: string): Promise<VinDecode> {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(
    vin
  )}?format=json`
  const raw: Record<string, string> = {}
  let r0: Record<string, string> = {}
  try {
    const res = await fetchWithTimeout(url, 8000)
    if (res.ok) {
      const data = await res.json()
      r0 = (data?.Results?.[0] ?? {}) as Record<string, string>
      for (const [k, v] of Object.entries(r0)) {
        if (v != null && String(v).trim() !== '') raw[k] = String(v)
      }
    }
  } catch {
    /* leave raw empty; everything below resolves to null */
  }

  const pick = (k: string) => (raw[k] && raw[k].trim() !== '' ? raw[k].trim() : null)
  const engine =
    [pick('DisplacementL') ? `${pick('DisplacementL')}L` : null, pick('EngineConfiguration'), pick('EngineCylinders') ? `${pick('EngineCylinders')}cyl` : null]
      .filter(Boolean)
      .join(' ') || null

  return {
    year: pick('ModelYear'),
    make: pick('Make'),
    model: pick('Model'),
    trim: pick('Trim') || pick('Series'),
    bodyClass: pick('BodyClass'),
    driveType: pick('DriveType'),
    engine,
    fuelType: pick('FuelTypePrimary'),
    plantCountry: pick('PlantCountry'),
    raw,
  }
}

function vehicleStringFromDecode(d: VinDecode): string | null {
  const parts = [d.year, d.make, d.model, d.trim].filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

// ---------------------------------------------------------------------------
// 2) Search connector (SerpAPI preferred, then Google CSE). No key -> null.
// ---------------------------------------------------------------------------
async function runSearch(
  query: string
): Promise<{ connector: 'serpapi' | 'google_cse'; hits: SearchHit[] } | null> {
  const serp = process.env.SERPAPI_KEY
  const cseKey = process.env.GOOGLE_CSE_API_KEY
  const cseId = process.env.GOOGLE_CSE_ID

  if (serp) {
    try {
      const u = `https://serpapi.com/search.json?engine=google&num=10&q=${encodeURIComponent(
        query
      )}&api_key=${encodeURIComponent(serp)}`
      const res = await fetchWithTimeout(u, 9000)
      if (res.ok) {
        const data = await res.json()
        const hits: SearchHit[] = (data?.organic_results ?? [])
          .map((o: any) => ({
            title: String(o?.title ?? ''),
            snippet: String(o?.snippet ?? o?.snippet_highlighted_words?.join(' ') ?? ''),
            link: String(o?.link ?? ''),
          }))
          .filter((h: SearchHit) => h.link)
        return { connector: 'serpapi', hits }
      }
    } catch {
      /* fall through */
    }
  }

  if (cseKey && cseId) {
    try {
      const u = `https://www.googleapis.com/customsearch/v1?num=10&key=${encodeURIComponent(
        cseKey
      )}&cx=${encodeURIComponent(cseId)}&q=${encodeURIComponent(query)}`
      const res = await fetchWithTimeout(u, 9000)
      if (res.ok) {
        const data = await res.json()
        const hits: SearchHit[] = (data?.items ?? [])
          .map((o: any) => ({
            title: String(o?.title ?? ''),
            snippet: String(o?.snippet ?? ''),
            link: String(o?.link ?? ''),
          }))
          .filter((h: SearchHit) => h.link)
        return { connector: 'google_cse', hits }
      }
    } catch {
      /* fall through */
    }
  }

  return null
}

// Preferred public auction archive domains, in priority order.
const PREFERRED = [
  'bid.cars',
  'bidcars',
  'bidfax',
  'copart',
  'iaai',
  'cleanvin',
  'autoauctionhistory',
  'carsfromwest',
  'salvagebid',
  'a-better-bid',
  'stat.vin',
  'epicvin',
]

function domainRank(link: string): number {
  const l = link.toLowerCase()
  for (let i = 0; i < PREFERRED.length; i++) {
    if (l.includes(PREFERRED[i])) return i
  }
  return PREFERRED.length + 1
}

function sourceNameFromLink(link: string, pageText: string): string | null {
  const l = link.toLowerCase()
  let base: string | null = null
  if (l.includes('bid.cars') || l.includes('bidcars')) base = 'BidCars'
  else if (l.includes('bidfax')) base = 'BidFax'
  else if (l.includes('copart')) base = 'Copart'
  else if (l.includes('iaai')) base = 'IAAI'
  else if (l.includes('cleanvin')) base = 'CleanVIN'
  else if (l.includes('stat.vin')) base = 'Stat.vin'
  else if (l.includes('epicvin')) base = 'EpicVIN'
  else {
    try {
      base = new URL(link).hostname.replace(/^www\./, '')
    } catch {
      base = null
    }
  }
  // If an aggregator references the underlying auction house, reflect it.
  const t = pageText.toLowerCase()
  if (base && base !== 'Copart' && base !== 'IAAI') {
    if (/\bcopart\b/.test(t)) return `${base} / Copart archive`
    if (/\biaai\b/.test(t)) return `${base} / IAAI archive`
  }
  return base
}

// ---------------------------------------------------------------------------
// 3) Conservative field extraction. Every field stays null unless matched.
// ---------------------------------------------------------------------------
function clean(s: string | undefined | null): string | null {
  if (!s) return null
  const t = s.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '').trim()
  return t || null
}

function parseMileage(text: string): { mileage: string | null; miles: number | null } {
  // A number that may use space/comma/dot as a thousands separator
  // (e.g. "191", "46,264", "46 264", "74.455"). Groups of exactly 3.
  const NUM = String.raw`(\d{1,3}(?:[ .,]\d{3})+|\d{1,7})`
  // Explicit odometer/mileage label first (strongest signal).
  const labeled =
    text.match(new RegExp(String.raw`(?:odometer|mileage)[^\d]{0,12}${NUM}\s*(mi|miles|km|kms)?`, 'i')) || null
  // Otherwise an explicit number followed by a unit.
  const unit = text.match(new RegExp(String.raw`\b${NUM}\s*(mi|miles|km|kms)\b`, 'i')) || null
  const m = labeled || unit
  if (!m) return { mileage: null, miles: null }

  const num = parseInt(m[1].replace(/[.,\s]/g, ''), 10)
  if (!Number.isFinite(num) || num <= 0 || num > 2_000_000) return { mileage: null, miles: null }
  const unitRaw = (m[2] || '').toLowerCase()

  let miles: number
  let km: number
  if (unitRaw.startsWith('km')) {
    km = num
    miles = Math.round(num / 1.609344)
  } else {
    // default to miles when label present without unit, or "mi/miles"
    miles = num
    km = Math.round(num * 1.609344)
  }
  const fmt = (n: number) => n.toLocaleString('en-US')
  return { mileage: `${fmt(miles)} mi / ${fmt(km)} km`, miles }
}

function firstGroup(text: string, re: RegExp): string | null {
  const m = text.match(re)
  return m ? clean(m[1]) : null
}

// Field labels that should terminate a captured value, so e.g.
// "Primary Damage: Front End Secondary Damage: Side" doesn't bleed the
// "Secondary Damage" label into the primary-damage value.
const STOP =
  String.raw`(?=\s+(?:secondary|primary|damage|loss|start|code|seller|title|odometer|mileage|location|lot|vin|sale|color|colour|body|engine|stock|year|make|model|highlights|notes|estimated|retail|actual|current|final|bid|keys?|transmission|fuel|cylinders|status|condition|document)\b|\s*[;,.|()/]|\s+\d|\s*$)`

// Capture the value after a label, stopping at the next label/punctuation/number.
function labeledValue(text: string, label: string, charClass = 'A-Za-z &\\-'): string | null {
  const re = new RegExp(`${label}[:,\\s]+([${charClass}]{1,40}?)${STOP}`, 'i')
  const m = text.match(re)
  return m ? clean(m[1]) : null
}

export function extractFields(text: string, decode: VinDecode): AuctionRecord {
  const rec = emptyAuctionRecord()
  if (!text) return rec
  const T = text.replace(/\s+/g, ' ')

  // Vehicle identity comes from the factory decode (not fabricated).
  rec.vehicle = vehicleStringFromDecode(decode)

  // Mileage (never guessed).
  const mil = parseMileage(T)
  rec.mileage = mil.mileage
  rec.mileageMiles = mil.miles

  // Lot number, e.g. "Lot 1-39538469" or "Lot# 39202433".
  rec.lot = firstGroup(T, /lot[\s#:]*([0-9]-?[0-9]{5,})/i)

  // Damage. Separator may be ":", ",", or whitespace; value stops at next label.
  rec.primaryDamage =
    labeledValue(T, 'primary damage') || labeledValue(T, '\\bdamage')
  rec.secondaryDamage = labeledValue(T, 'secondary damage')

  // Location: prefer "City (ST)" (common on auction archives), then "City, ST",
  // rejecting obvious non-place tokens that precede a state code.
  const JUNK = /^(type|state|title|color|colour|style|engine|drive|body|vin|odometer|damage|interior|exterior|status)$/i
  const paren = T.match(/\b([A-Z][A-Za-z][A-Za-z .'-]{1,26}?)\s*\(([A-Z]{2})\)/)
  if (paren && !JUNK.test(paren[1].trim())) {
    rec.location = `${clean(paren[1])}, ${paren[2]}`
  } else {
    const comma = T.match(/\b([A-Z][A-Za-z][A-Za-z .'-]{1,26}?),\s*([A-Z]{2})\b/)
    if (comma && !JUNK.test(comma[1].trim())) rec.location = `${clean(comma[1])}, ${comma[2]}`
  }

  // Photo / record counts.
  const photos = T.match(/([0-9]{1,3})\s*(?:photos|images|pictures)\b/i)
  if (photos) rec.photosFound = parseInt(photos[1], 10)
  const recs = T.match(/([0-9]{1,3})\s*(?:auction records|sale records|records found|lots? found)\b/i)
  if (recs) rec.auctionRecords = parseInt(recs[1], 10)

  // Sale document / title status. State code may precede ("CA SALVAGE CERTIFICATE").
  const DOC = /(salvage certificate|certificate of title|clean title|rebuilt title|salvage title|junk title|non[- ]?repairable)/i
  const docWithState = T.match(new RegExp(String.raw`\b([A-Z]{2})\s+${DOC.source}`, 'i'))
  if (docWithState) {
    const doc = clean(docWithState[2]) || ''
    rec.saleDocument = `${doc.charAt(0).toUpperCase()}${doc.slice(1).toLowerCase()}, ${docWithState[1].toUpperCase()}`
  } else {
    const docOnly = T.match(DOC)
    if (docOnly) {
      const doc = clean(docOnly[1]) || ''
      rec.saleDocument = `${doc.charAt(0).toUpperCase()}${doc.slice(1).toLowerCase()}`
    }
  }

  // Loss type.
  rec.loss =
    labeledValue(T, 'loss') ||
    (/\bcollision\b/i.test(T)
      ? 'Collision'
      : /\bflood|water\b/i.test(T)
      ? 'Water/Flood'
      : /\bvandalism\b/i.test(T)
      ? 'Vandalism'
      : null)

  // Start code.
  rec.startCode =
    labeledValue(T, 'start code') ||
    (/\bstationary\b/i.test(T)
      ? 'Stationary'
      : /\bruns? and drives?\b/i.test(T)
      ? 'Run and Drive'
      : /\benhanced\b/i.test(T)
      ? 'Enhanced'
      : null)

  // Seller.
  rec.seller = labeledValue(T, 'seller', "A-Za-z .&'\\-")

  return rec
}

// ---------------------------------------------------------------------------
// 4) Orchestration
// ---------------------------------------------------------------------------
export async function lookupVinHistory(
  vin: string,
  decode: VinDecode
): Promise<{ auctionRecord: AuctionRecord; sourceRecord: SourceRecord; connector: VinLookupResult['connector'] }> {
  const googleSearchLink = `https://www.google.com/search?q=${encodeURIComponent(`"${vin}" auction`)}`

  // Try the configured connector. Two queries max.
  const search =
    (await runSearch(`"${vin}"`)) ||
    null

  // No connector configured -> clean fallback: decode + ONE search link only.
  if (!search) {
    const rec = emptyAuctionRecord()
    rec.vehicle = vehicleStringFromDecode(decode)
    return {
      auctionRecord: rec,
      sourceRecord: { sourceName: null, sourceUrl: googleSearchLink },
      connector: null,
    }
  }

  // Rank hits: preferred auction domains first, then by appearance.
  const ranked = [...search.hits].sort((a, b) => domainRank(a.link) - domainRank(b.link))
  const best = ranked.find((h) => domainRank(h.link) <= PREFERRED.length) || ranked[0] || null

  if (!best) {
    const rec = emptyAuctionRecord()
    rec.vehicle = vehicleStringFromDecode(decode)
    return {
      auctionRecord: rec,
      sourceRecord: { sourceName: null, sourceUrl: googleSearchLink },
      connector: search.connector,
    }
  }

  // Base text from the search result itself.
  let combined = `${best.title} ${best.snippet}`
  let pageText = ''

  // Optionally fetch the chosen source page for richer structured fields.
  // Default ON; disable with VIN_HISTORY_FETCH_PAGE=0. Single request, short
  // timeout, conservative. Failure simply leaves fields null.
  if (process.env.VIN_HISTORY_FETCH_PAGE !== '0') {
    try {
      const res = await fetchWithTimeout(best.link, 9000, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          Accept: 'text/html',
        },
      })
      if (res.ok) {
        const html = await res.text()
        pageText = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .slice(0, 60000)
        combined = `${combined} ${pageText}`
      }
    } catch {
      /* keep snippet-only extraction */
    }
  }

  const auctionRecord = extractFields(combined, decode)
  const sourceRecord: SourceRecord = {
    sourceName: sourceNameFromLink(best.link, combined),
    sourceUrl: best.link,
  }

  return { auctionRecord, sourceRecord, connector: search.connector }
}

export async function vinLookup(vinInput: string): Promise<VinLookupResult> {
  const vin = (vinInput || '').trim().toUpperCase()
  const decode = await decodeVin(vin)
  const { auctionRecord, sourceRecord, connector } = await lookupVinHistory(vin, decode)
  return { vin, decode, auctionRecord, sourceRecord, connector }
}
