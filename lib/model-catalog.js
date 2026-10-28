// ──────────────────────────────────────────────
// Live model catalog from Anthropic's Models API
// ──────────────────────────────────────────────
//
// GET https://api.anthropic.com/v1/models accepts the subscription OAuth
// token (same beta header as the usage endpoint) and returns, per model:
// `line` (tier), `max_input_tokens`, and `capabilities` — including which
// thinking types (adaptive / enabled / disabled) and effort levels it
// supports. That replaces the hand-maintained catalog + name heuristics in
// models.js, which remain only as the offline fallback.
//
// Cached for an hour. Consumers read the cache synchronously
// (getLiveCatalog) and trigger refreshes without awaiting them on the hot
// chat path; /v1/models awaits a refresh so the picker is current.
//
// CLAUDE_SUBSCRIPTION_STATIC_MODELS=1 skips the API and uses the built-in
// catalog only.

import { readCredentials, refreshOAuthToken } from './oauth.js';

const PLUGIN_TAG = '[claude-subscription]';
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const ANTHROPIC_VERSION = '2023-06-01';
const CATALOG_TTL_MS = 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const ONE_M_TOKENS = 1000000;
const BASE_CONTEXT = 200000;

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

let liveCatalog = null;   // { models, fetchedAt }
let lastFailureAt = 0;
let inflight = null;

/** Anthropic Models API entry → catalog entry (same shape as the static
 *  catalog in models.js, plus capability data). */
export function normalizeApiModel(m) {
    const maxInput = Number(m.max_input_tokens) || BASE_CONTEXT;
    const thinking = m.capabilities?.thinking;
    const types = thinking?.types ?? {};
    const effort = m.capabilities?.effort;
    return {
        id: m.id,
        name: m.display_name || m.id,
        tier: m.line || null,
        createdAt: Date.parse(m.created_at) || 0,
        oneM: maxInput >= ONE_M_TOKENS,
        context: Math.min(maxInput, BASE_CONTEXT),
        maxContext: maxInput,
        thinkingTypes: thinking?.supported === false
            ? { adaptive: false, enabled: false, disabled: true }
            : {
                adaptive: types.adaptive?.supported === true,
                enabled: types.enabled?.supported === true,
                disabled: types.disabled?.supported === true,
            },
        // null = effort parameter unsupported entirely.
        efforts: effort?.supported ? EFFORT_LEVELS.filter((l) => effort[l]?.supported) : null,
    };
}

async function fetchOnce(token) {
    return fetch(MODELS_URL, {
        headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': OAUTH_BETA_HEADER,
            'anthropic-version': ANTHROPIC_VERSION,
            Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10000),
    });
}

async function doRefresh() {
    let token = readCredentials()?.claudeAiOauth?.accessToken;
    if (!token) return null;
    try {
        let res = await fetchOnce(token);
        if (res.status === 401 && await refreshOAuthToken()) {
            token = readCredentials()?.claudeAiOauth?.accessToken;
            if (token) res = await fetchOnce(token);
        }
        if (!res.ok) {
            console.warn(`${PLUGIN_TAG} model list fetch returned HTTP ${res.status} — using ${liveCatalog ? 'cached' : 'built-in'} catalog`);
            lastFailureAt = Date.now();
            return liveCatalog;
        }
        const raw = await res.json();
        const models = (Array.isArray(raw.data) ? raw.data : [])
            .filter((m) => m && typeof m.id === 'string' && (m.lifecycle ?? 'active') === 'active')
            .map(normalizeApiModel);
        if (models.length === 0) {
            lastFailureAt = Date.now();
            return liveCatalog;
        }
        liveCatalog = { models, fetchedAt: Date.now() };
        return liveCatalog;
    } catch (err) {
        console.warn(`${PLUGIN_TAG} model list fetch failed:`, err instanceof Error ? err.message : err);
        lastFailureAt = Date.now();
        return liveCatalog;
    }
}

function liveDisabled() {
    return /^(1|true|yes|on)$/i.test(process.env.CLAUDE_SUBSCRIPTION_STATIC_MODELS ?? '');
}

/** Refresh the cache if stale (deduped; failures back off for 5 minutes). */
export function refreshModelCatalog({ force = false } = {}) {
    if (liveDisabled()) return Promise.resolve(liveCatalog);
    const fresh = liveCatalog && Date.now() - liveCatalog.fetchedAt < CATALOG_TTL_MS;
    const backingOff = Date.now() - lastFailureAt < FAILURE_BACKOFF_MS;
    if (!force && (fresh || backingOff)) return Promise.resolve(liveCatalog);
    if (!inflight) inflight = doRefresh().finally(() => { inflight = null; });
    return inflight;
}

/** Cached live models, or null when never fetched successfully. */
export function getLiveCatalog() {
    return liveCatalog?.models ?? null;
}

/** Test seam. */
export function __setLiveCatalogForTesting(models) {
    liveCatalog = models ? { models, fetchedAt: Date.now() } : null;
    lastFailureAt = 0;
}
