// ──────────────────────────────────────────────
// Listener access control: Host allowlist + per-install proxy key
// ──────────────────────────────────────────────
//
// The standalone listener sits outside SillyTavern's auth and CSRF stack, so
// without these checks anything that can reach the port can spend the
// subscription:
//
//   • Host allowlist — a browser only refuses the cross-origin POST because
//     the CORS preflight 404s; DNS rebinding sidesteps that (attacker domain
//     re-resolves to 127.0.0.1, the request becomes "same-origin"). Rebound
//     requests still carry the attacker's hostname in Host, so rejecting any
//     Host that isn't loopback or the configured bind host closes it.
//   • Proxy key — a random secret minted on first start and stored next to
//     the plugin (.proxy-key, 0600). Required on POST /v1/chat/completions.
//     The UI extension fetches it from the SAME-ORIGIN SillyTavern plugin
//     route (behind ST's own login/whitelist) and injects it through
//     `custom_include_body`, so other local processes and LAN hosts can't
//     use the proxy without it. Direct API users send it as
//     `Authorization: Bearer <key>` or `claude_subscription.proxy_key`.
//
// Env overrides:
//   CLAUDE_SUBSCRIPTION_KEY=…            use this key instead of .proxy-key
//   CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS=a,b extra Host names to accept
//   CLAUDE_SUBSCRIPTION_NO_AUTH=1        disable the proxy-key check (Host
//                                        allowlist still applies)

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_TAG = '[claude-subscription]';
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
const WILDCARD_HOSTS = ['0.0.0.0', '::', '[::]'];

let cachedKey = null;

function keyFilePath() {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '.proxy-key');
}

export function authDisabled() {
    return /^(1|true|yes|on)$/i.test(process.env.CLAUDE_SUBSCRIPTION_NO_AUTH ?? '');
}

/** Load (or mint on first use) the proxy key. */
export function getProxyKey() {
    if (cachedKey) return cachedKey;
    const fromEnv = (process.env.CLAUDE_SUBSCRIPTION_KEY ?? '').trim();
    if (fromEnv) {
        cachedKey = fromEnv;
        return cachedKey;
    }
    const path = keyFilePath();
    try {
        if (existsSync(path)) {
            const stored = readFileSync(path, 'utf8').trim();
            if (stored) {
                cachedKey = stored;
                return cachedKey;
            }
        }
    } catch (err) {
        console.warn(`${PLUGIN_TAG} could not read ${path}:`, err instanceof Error ? err.message : err);
    }
    cachedKey = `csp-${randomBytes(32).toString('base64url')}`;
    try {
        writeFileSync(path, cachedKey + '\n', { mode: 0o600 });
        console.log(`${PLUGIN_TAG} generated proxy key at ${path}`);
    } catch (err) {
        // Still usable for this process lifetime; the extension re-fetches it.
        console.warn(`${PLUGIN_TAG} could not persist proxy key (${err instanceof Error ? err.message : err}) — it will change on restart`);
    }
    return cachedKey;
}

function keysEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Strip the port from a Host header value ("[::1]:8901" → "[::1]"). */
function hostName(header) {
    const h = String(header ?? '').trim().toLowerCase();
    if (h.startsWith('[')) {
        const end = h.indexOf(']');
        return end === -1 ? h : h.slice(0, end + 1);
    }
    return h.replace(/:\d+$/, '');
}

/** Express middleware: reject requests whose Host isn't loopback, the bind
 *  host, or explicitly allowlisted. */
export function makeHostGuard(bindHost) {
    const allowed = new Set(LOOPBACK_HOSTS);
    const bind = String(bindHost ?? '').trim().toLowerCase();
    if (bind && !WILDCARD_HOSTS.includes(bind)) allowed.add(bind);
    for (const extra of (process.env.CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS ?? '').split(',')) {
        const name = extra.trim().toLowerCase();
        if (name) allowed.add(name);
    }

    return function hostGuard(req, res, next) {
        const name = hostName(req.headers.host);
        if (allowed.has(name)) return next();
        console.warn(`${PLUGIN_TAG} rejected request with Host "${req.headers.host}" (add it to CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS if legitimate)`);
        return res.status(403).json({ error: { message: 'Host not allowed', type: 'forbidden' } });
    };
}

/** Express middleware: require the proxy key on chat completions. */
export function requireProxyKey(req, res, next) {
    if (authDisabled()) return next();
    const expected = getProxyKey();

    const ns = req.body?.claude_subscription;
    const fromBody = ns && typeof ns === 'object' ? ns.proxy_key : undefined;
    const bearer = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

    if ((fromBody && keysEqual(fromBody, expected)) || (bearer && keysEqual(bearer, expected))) {
        return next();
    }
    return res.status(401).json({
        error: {
            message: 'Missing or invalid proxy key. Enable the Claude Max panel (it supplies the key ' +
                'automatically), or send the key from the plugin\'s .proxy-key file as ' +
                '`Authorization: Bearer <key>`.',
            type: 'unauthorized',
        },
    });
}

/** SillyTavern-mounted route: hands the key to the same-origin UI extension. */
export function handleProxyKey(_req, res) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, required: !authDisabled(), key: authDisabled() ? null : getProxyKey() });
}
