/* Guardian Service Worker — v3 */

const GHPATH = '/guardian';
const APP_PREFIX = 'guardian_';
const VERSION = 'v3'; // bump this every time you change the file or want fresh lists

// Blocklist sources (raw GitHub URLs — update or add more as needed)
const BLOCKLIST_URLS = [
    'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts',
    'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts'
];

// Files cached for offline use
const STATIC_ASSETS = [
    `${GHPATH}/`,
    `${GHPATH}/index.html`,
    `${GHPATH}/blocked.html`,
    `${GHPATH}/manifest.json`,
    `${GHPATH}/icon-192x192.png`,
    `${GHPATH}/icon-512x512.png`
];

// In-memory set of blocked domains
let blockedDomains = new Set();
let blocklistReady = false;

/* ---------- Blocklist loading ---------- */

async function loadBlocklist() {
    try {
        const responses = await Promise.all(BLOCKLIST_URLS.map(u => fetch(u, { cache: 'no-store' })));
        const texts = await Promise.all(responses.map(r => r.text()));

        texts.forEach(text => {
            text.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return;

                // Hosts format: "0.0.0.0 domain.com" or "127.0.0.1 domain.com"
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 2) {
                    const domain = parts[1].toLowerCase();
                    if (
                        domain &&
                        domain !== '0.0.0.0' &&
                        domain !== '127.0.0.1' &&
                        domain !== 'localhost' &&
                        domain !== 'localhost.localdomain' &&
                        !domain.includes('#')
                    ) {
                        blockedDomains.add(domain);
                    }
                }
            });
        });

        blocklistReady = true;
        console.log(`Guardian: ${blockedDomains.size} domains loaded.`);
        broadcastStatus('ready', blockedDomains.size);
    } catch (err) {
        console.error('Guardian: blocklist load failed', err);
        broadcastStatus('error', 0);
    }
}

// Persist the parsed domains so cold starts are instant
async function persistBlocklist() {
    const cache = await caches.open(`${APP_PREFIX}blocklist_${VERSION}`);
    const payload = new Response(JSON.stringify([...blockedDomains]), {
        headers: { 'Content-Type': 'application/json' }
    });
    await cache.put(`${GHPATH}/__blocklist.json`, payload);
}

async function restoreBlocklist() {
    const cache = await caches.open(`${APP_PREFIX}blocklist_${VERSION}`);
    const cached = await cache.match(`${GHPATH}/__blocklist.json`);
    if (cached) {
        try {
            const arr = await cached.json();
            blockedDomains = new Set(arr);
            blocklistReady = true;
            console.log(`Guardian: restored ${blockedDomains.size} domains from cache.`);
            broadcastStatus('ready', blockedDomains.size);
            return true;
        } catch (e) {
            console.warn('Guardian: could not restore blocklist', e);
        }
    }
    return false;
}

/* ---------- Helpers ---------- */

function isBlocked(hostname) {
    if (!hostname) return false;
    const host = hostname.toLowerCase();
    if (blockedDomains.has(host)) return true;
    // Check parent domains: ads.example.com → example.com
    const parts = host.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
        if (blockedDomains.has(parts.slice(i).join('.'))) return true;
    }
    return false;
}

function broadcastStatus(state, count) {
    self.clients.matchAll().then(clients => {
        clients.forEach(client =>
            client.postMessage({ type: 'STATUS', status: state, count })
        );
    });
}

function blockedResponse() {
    return caches.match(`${GHPATH}/blocked.html`).then(res =>
        res ||
        new Response('Blocked by Guardian', {
            status: 403,
            headers: { 'Content-Type': 'text/plain' }
        })
    );
}

/* ---------- Lifecycle ---------- */

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(`${APP_PREFIX}${VERSION}`);
        // Cache assets individually so one 404 doesn't fail the whole install
        await Promise.all(
            STATIC_ASSETS.map(url =>
                cache.add(url).catch(e => console.warn('Guardian: skip cache', url, e))
            )
        );
        await loadBlocklist();
        await persistBlocklist();
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        // Remove caches from older versions
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter(k => k.startsWith(APP_PREFIX) && k !== `${APP_PREFIX}${VERSION}` && k !== `${APP_PREFIX}blocklist_${VERSION}`)
                .map(k => caches.delete(k))
        );
        await self.clients.claim();
        // If blocklist wasn't ready (unlikely), try restoring from cache
        if (!blocklistReady) await restoreBlocklist();
    })());
});

/* ---------- Message channel (UI checks) ---------- */

self.addEventListener('message', event => {
    const data = event.data || {};
    if (data.type === 'CHECK_URL' && event.ports && event.ports[0]) {
        event.ports[0].postMessage({ blocked: isBlocked(data.hostname) });
    }
    if (data.type === 'GET_STATUS') {
        broadcastStatus(blocklistReady ? 'ready' : 'loading', blockedDomains.size);
    }
});

/* ---------- Fetch: the real gatekeeper ---------- */

self.addEventListener('fetch', event => {
    const req = event.request;

    // Always pass through the blocklist JSON and manifest requests to normal cache handling
    // Block navigations whose hostname is on the list
    if (req.mode === 'navigate') {
        let hostname = '';
        try { hostname = new URL(req.url).hostname; } catch {}

        if (isBlocked(hostname)) {
            console.warn(`Guardian: blocked navigation → ${hostname}`);
            event.respondWith(blockedResponse());
            return;
        }
    }

    // Cache-first for GETs; fall back to network
    if (req.method === 'GET') {
        event.respondWith(
            caches.match(req).then(cached => {
                if (cached) return cached;
                return fetch(req)
                    .then(response => {
                        // Don't cache third-party cross-origin requests
                        return response;
                    })
                    .catch(() => {
                        // Offline fallback for navigations
                        if (req.mode === 'navigate') {
                            return caches.match(`${GHPATH}/index.html`);
                        }
                        return new Response('Offline', { status: 503 });
                    });
            })
        );
    }
});
