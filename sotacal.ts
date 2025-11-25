// SOTA Alerts → ICS Cloudflare Worker
// Deploy: wrangler deploy
// Default: returns ICS. Add ?format=json for raw alerts.

const ALERTS_URL = "https://api-db2.sota.org.uk/api/alerts/12/all/all/";

interface SotaAlert {
  id: number;
  userID: number;
  timeStamp: string;         // ISO last modified timestamp
  dateActivated: string;     // ISO date string (UTC Z)
  associationCode: string;
  summitCode: string;
  summitDetails: string;
  frequency?: string;
  comments?: string;
  activatingCallsign: string;
  activatorName?: string;
  posterCallsign?: string;
  epoch: string;
}

// Minimal FetchEvent interface for worker environments (Cloudflare Workers)
interface FetchEvent extends Event {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
  waitUntil(promise: Promise<unknown>): void;
}

// Augment CacheStorage to include Cloudflare Workers' caches.default
interface CacheStorage {
  default: Cache;
}

addEventListener("fetch", (event) => {
  (event as FetchEvent).respondWith(handleRequest(event as FetchEvent));
});

async function handleRequest(event: FetchEvent): Promise<Response> {
  const request = event.request;
  const url = new URL(request.url);
  const format = url.searchParams.get("format");

  // Use Cloudflare cache
  const cache = caches.default;
  const cacheKey = new Request(ALERTS_URL, { method: "GET" });
  let cached = await cache.match(cacheKey);
  let alerts: SotaAlert[];

  if (cached) {
    alerts = await cached.json();
  } else {
    const res = await fetch(ALERTS_URL);
    if (!res.ok) {
      return new Response(`Upstream fetch error: ${res.status}`, { status: 502 });
    }
    alerts = await res.json();
    // Store in cache for 5 minutes
    const cacheResp = new Response(JSON.stringify(alerts), {
      headers: { "Cache-Control": "public, max-age=300" },
    });
    event.waitUntil(cache.put(cacheKey, cacheResp.clone()));
  }

  if (format === "json") {
    return jsonResponse(alerts);
  }

  const ics = await buildICS(alerts);
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": "inline; filename=\"sota_alerts.ics\"",
      "Cache-Control": "public, max-age=120",
    },
  });
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// Build ICS file
async function buildICS(alerts: SotaAlert[]): Promise<string> {
  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("PRODID:-//SOTA Alerts//EN");
  lines.push("VERSION:2.0");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");

  for (const alert of alerts) {
    try {
      lines.push("BEGIN:VEVENT");
      const now = new Date();
      const summitTime = parseISO(alert.dateActivated);
      const timeStamp = parseISO(alert.timeStamp);

      const title =
        `${alert.activatingCallsign} on ${alert.associationCode}/${alert.summitCode}`;

      const { begin, end } = computeWindow(summitTime, alert.comments);
      const uid = await computeUID(title, summitTime);

      lines.push(`UID:${uid}`);
      lines.push(`DTSTAMP:${formatICSDate(now)}`);
      lines.push(`SUMMARY:${escapeICS(title)}`);
      lines.push(`DTSTART:${formatICSDate(begin)}`);
      lines.push(`DTEND:${formatICSDate(end)}`);

      const ago = relativeTime(now.getTime() - timeStamp.getTime());

      const descParts: string[] = [];
      descParts.push(`Freqs: ${alert.frequency || "Unknown"}`);
      if (alert.comments) {
        descParts.push(`Comments: ${alert.comments}`);
      }
      descParts.push(
        `Last updated ${ago} by ${alert.posterCallsign || "Unknown"}`
      );

      lines.push(`DESCRIPTION:${escapeICS(descParts.join("\\n"))}`);
      lines.push("END:VEVENT");
    } catch (err) {
      // Skip malformed alert
      console.warn("Skipping alert due to error:", err);
    }
  }

  lines.push("END:VCALENDAR");
  return foldICS(lines).join("\r\n") + "\r\n";
}

// Compute begin/end using S+N / S-N logic
function computeWindow(summitTime: Date, comments?: string): { begin: Date; end: Date } {
  let hoursAfter = 3;
  let hoursBefore = 1;

  if (comments) {
    const plusMatch = comments.match(/[Ss]\+(\d+)/);
    if (plusMatch) hoursAfter = parseInt(plusMatch[1], 10);
    const minusMatch = comments.match(/[Ss]-(\d+)/);
    if (minusMatch) hoursBefore = parseInt(minusMatch[1], 10);
  }
  const begin = new Date(summitTime.getTime() - hoursBefore * 3600_000);
  const end = new Date(summitTime.getTime() + hoursAfter * 3600_000);
  return { begin, end };
}

// Relative time (simple humanize)
function relativeTime(msDiff: number): string {
  const sec = Math.round(msDiff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const week = Math.round(day / 7);
  if (week < 4) return `${week}w ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month}mo ago`;
  const year = Math.round(day / 365);
  return `${year}y ago`;
}

// Parse ISO with Z; fallback
function parseISO(s: string): Date {
  return new Date(s);
}

// ICS date format YYYYMMDDTHHMMSSZ
function formatICSDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

// Escape commas, semicolons, backslashes per RFC5545
function escapeICS(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\r?\n/g, "\\n");
}

// SHA1 hex via Web Crypto
async function computeUID(title: string, summitTime: Date): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(title + summitTime.getUTCMonth().toString());
  const digest = await crypto.subtle.digest("SHA-1", data);
  const bytes = Array.from(new Uint8Array(digest));
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}@sota.org.uk`;
}

// Fold lines at 75 octets with continuation
function foldICS(lines: string[]): string[] {
  const folded: string[] = [];
  for (const line of lines) {
    let current = line;
    while (utf8Length(current) > 75) {
      let sliceLen = 75;
      // Adjust to not cut inside escape sequences (simple approach)
      let part = current.slice(0, sliceLen);
      folded.push(part);
      current = " " + current.slice(sliceLen);
    }
    folded.push(current);
  }
  return folded;
}

function utf8Length(str: string): number {
  return new TextEncoder().encode(str).length;
}