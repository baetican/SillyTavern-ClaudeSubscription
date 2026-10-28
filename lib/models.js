// ──────────────────────────────────────────────
// Claude Subscription model catalog + request parsing
// ──────────────────────────────────────────────
//
// Two-layer model story (mirrors Meridian's proven mechanism rather than
// Marinara v2.0.8, which regressed 1M handling by stamping 1M context on the
// plain IDs without enabling anything):
//
//   1. The picker exposes full model IDs plus explicit "(1M context)"
//      variants suffixed `[1m]` — e.g. `claude-opus-4-8[1m]`.
//   2. For a base request we pass the full model ID straight to the SDK.
//      For a `[1m]` request we pass the CLI's tier alias with the 1M suffix
//      (`opus[1m]`, `fable[1m]`, `sonnet[1m]`) as `Options.model` and pin
//      the tier's concrete version via ANTHROPIC_DEFAULT_<TIER>_MODEL in the
//      subprocess env — that is exactly how the Claude Code CLI's own
//      "/model … [1m]" picker entries resolve, and how Meridian serves 1M.
//
// The catalog itself is LIVE (model-catalog.js → Anthropic's Models API):
// tiers, 1M eligibility, thinking types and effort levels come from the
// API's capability data. The static list below is only the offline
// fallback, with name-based heuristics for capabilities.
//
// 1M context requires Extra Usage on some plans; failures are handled by the
// caller via stripExtendedContext + the 1-hour cooldown below (probe pattern
// copied from Meridian: one failed [1m] request arms the cooldown, base model
// serves in the meantime, a single probe retries after the hour).

import { EFFORT_LEVELS, getLiveCatalog, refreshModelCatalog } from './model-catalog.js';

const TIER_ENV = {
    fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

// Fallback tier defaults — pinned under the request-specific pin so the
// CLI's bundled (possibly stale) defaults never decide a tier we didn't pin
// explicitly (Meridian issue #419 class of bug). The live catalog's newest
// model per tier takes precedence (see canonicalTierModels).
export const CANONICAL_TIER_MODELS = {
    fable: 'claude-fable-5-1',
    opus: 'claude-opus-5-5',
    sonnet: 'claude-sonnet-5-5',
    haiku: 'claude-haiku-5-5',
};

// Offline fallback catalog. `adaptiveOnly` = always-thinking model families;
// `thinking: { type: 'enabled' | 'disabled' }` is assumed invalid — only
// adaptive applies. The live catalog carries exact per-model capabilities.
export const CLAUDE_SUBSCRIPTION_MODELS = [
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', tier: 'fable', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-fable-5', name: 'Claude Fable 5', tier: 'fable', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tier: 'opus', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-opus-5', name: 'Claude Opus 5', tier: 'opus', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tier: 'sonnet', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', tier: 'sonnet', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', tier: 'haiku', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'opus', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', tier: 'opus', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'opus', oneM: true, adaptiveOnly: false, context: 200000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'sonnet', oneM: true, adaptiveOnly: false, context: 200000 },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', tier: 'opus', oneM: false, adaptiveOnly: false, context: 200000 },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', tier: 'sonnet', oneM: false, adaptiveOnly: false, context: 200000 },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'haiku', oneM: false, adaptiveOnly: false, context: 200000 },
];

const ONE_M_SUFFIX = '[1m]';

/** Current catalog: live when available, static fallback otherwise. */
export function currentCatalog() {
    return getLiveCatalog() ?? CLAUDE_SUBSCRIPTION_MODELS;
}

function findIn(list, raw, normalized) {
    return list.find((m) => m.id === raw || m.id === normalized) || null;
}

function catalogEntry(baseId) {
    const raw = String(baseId).toLowerCase();
    const normalized = raw.replace(/\./g, '-');
    const live = getLiveCatalog();
    return (live && findIn(live, raw, normalized)) || findIn(CLAUDE_SUBSCRIPTION_MODELS, raw, normalized);
}

/** Tier guess for model IDs not in any catalog (forward compatibility). */
function guessTier(id) {
    const s = String(id).toLowerCase();
    if (s.includes('fable') || s.includes('mythos')) return 'fable';
    if (s.includes('opus')) return 'opus';
    if (s.includes('haiku')) return 'haiku';
    return 'sonnet';
}

/** Always-thinking family detection by name — fallback heuristic only. */
export function isAdaptiveOnlyModel(id) {
    const s = String(id).toLowerCase();
    const entry = findIn(CLAUDE_SUBSCRIPTION_MODELS, s.replace(/\[1m\]$/, ''), s.replace(/\[1m\]$/, '').replace(/\./g, '-'));
    if (entry) return entry.adaptiveOnly;
    return (
        /claude-opus-(?:4-(?:[7-9]|\d{2,})|[5-9]|\d{2,})/.test(s) ||
        s.includes('fable') ||
        s.includes('mythos')
    );
}

/** Supported thinking types: live capability data, else the heuristic
 *  (adaptive-only → adaptive; otherwise everything allowed, as before). */
function thinkingTypesFor(entry, baseId) {
    if (entry?.thinkingTypes) return entry.thinkingTypes;
    return isAdaptiveOnlyModel(baseId)
        ? { adaptive: true, enabled: false, disabled: false }
        : { adaptive: true, enabled: true, disabled: true };
}

/** Newest live model per tier, falling back to the static pins. */
export function canonicalTierModels() {
    const pins = { ...CANONICAL_TIER_MODELS };
    const live = getLiveCatalog();
    if (!live) return pins;
    for (const tier of Object.keys(TIER_ENV)) {
        const newest = live
            .filter((m) => m.tier === tier)
            .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (newest) pins[tier] = newest.id;
    }
    return pins;
}

/**
 * Parse the model string from the request into everything the SDK call needs.
 *
 * @param {string} requested e.g. 'claude-opus-5', 'claude-fable-5-1[1m]'
 * @returns {{ requested: string, baseId: string, tier: string, oneM: boolean,
 *            sdkModel: string, envPins: Record<string,string>, adaptiveOnly: boolean,
 *            thinkingTypes: {adaptive: boolean, enabled: boolean, disabled: boolean},
 *            efforts: string[]|null|undefined }}
 */
export function parseModelRequest(requested) {
    const raw = String(requested).trim();
    const oneM = raw.endsWith(ONE_M_SUFFIX);
    const rawBaseId = oneM ? raw.slice(0, -ONE_M_SUFFIX.length) : raw;
    const entry = catalogEntry(rawBaseId);
    const baseId = entry ? entry.id : rawBaseId;
    const tier = (entry?.tier && TIER_ENV[entry.tier]) ? entry.tier : guessTier(baseId);

    // Canonical pins for every tier first, then override the requested tier
    // with the exact version the user picked — the request's semantics MUST
    // win over both canonical defaults and any inherited shell env.
    const envPins = {};
    const canonical = canonicalTierModels();
    for (const [t, envVar] of Object.entries(TIER_ENV)) {
        envPins[envVar] = canonical[t];
    }
    envPins[TIER_ENV[tier]] = baseId;

    const effectiveOneM = oneM && (entry ? entry.oneM : true);
    // Base request → full model ID direct to the SDK (per-request exactness).
    // [1m] request → tier alias + [1m] suffix; env pin resolves the version.
    const sdkModel = effectiveOneM ? `${tier}${ONE_M_SUFFIX}` : baseId;

    const thinkingTypes = thinkingTypesFor(entry, baseId);
    return {
        requested: raw,
        baseId,
        tier,
        oneM: effectiveOneM,
        sdkModel,
        envPins,
        adaptiveOnly: !thinkingTypes.enabled && !thinkingTypes.disabled,
        thinkingTypes,
        // undefined = unknown (pass effort through); null = unsupported.
        efforts: entry && 'efforts' in entry ? entry.efforts : undefined,
    };
}

/**
 * Map the requested thinking setting onto what the model supports.
 * 'on' needs `enabled`, 'off' needs `disabled`; anything unsupported
 * degrades to adaptive (and adaptive to whatever exists).
 *
 * @param {{ thinkingTypes: {adaptive: boolean, enabled: boolean, disabled: boolean} }} modelInfo
 * @param {'off'|'adaptive'|'on'} requested
 * @returns {'adaptive'|'enabled'|'disabled'}
 */
export function resolveThinkingMode(modelInfo, requested) {
    const t = modelInfo.thinkingTypes;
    if (requested === 'on' && t.enabled) return 'enabled';
    if (requested === 'off' && t.disabled) return 'disabled';
    if (t.adaptive) return 'adaptive';
    if (t.enabled && requested !== 'off') return 'enabled';
    return t.disabled ? 'disabled' : 'adaptive';
}

/**
 * Clamp an effort level to what the model supports: nearest supported level
 * at or below the request, else the lowest above it. Returns undefined when
 * the model takes no effort parameter at all.
 */
export function resolveEffort(modelInfo, effort) {
    if (!effort) return undefined;
    const supported = modelInfo.efforts;
    if (supported === undefined) return effort; // unknown model → pass through
    if (!supported || supported.length === 0) return undefined;
    if (supported.includes(effort)) return effort;
    const idx = EFFORT_LEVELS.indexOf(effort);
    const below = supported.filter((l) => EFFORT_LEVELS.indexOf(l) < idx);
    if (below.length) return below[below.length - 1];
    return supported[0];
}

// ──────────────────────────────────────────────
// Extra Usage / 1M cooldown (Meridian's probe pattern)
// ──────────────────────────────────────────────

const EXTRA_USAGE_RETRY_MS = 60 * 60 * 1000; // 1 hour
let extraUsageUnavailableAt = 0;

export function recordExtendedContextUnavailable() {
    extraUsageUnavailableAt = Date.now();
}

export function isExtendedContextKnownUnavailable() {
    return extraUsageUnavailableAt > 0 && Date.now() - extraUsageUnavailableAt < EXTRA_USAGE_RETRY_MS;
}

/** Test seam. */
export function resetExtendedContextUnavailable() {
    extraUsageUnavailableAt = 0;
}

// ──────────────────────────────────────────────
// /v1/models handler
// ──────────────────────────────────────────────

export async function listModelsHandler(_req, res) {
    await refreshModelCatalog();
    const data = [];
    for (const m of currentCatalog()) {
        data.push({
            id: m.id,
            object: 'model',
            created: m.createdAt ? Math.floor(m.createdAt / 1000) : 0,
            owned_by: 'anthropic',
            display_name: m.name,
            context_window: m.context,
        });
        if (m.oneM) {
            data.push({
                id: `${m.id}${ONE_M_SUFFIX}`,
                object: 'model',
                created: m.createdAt ? Math.floor(m.createdAt / 1000) : 0,
                owned_by: 'anthropic',
                display_name: `${m.name} (1M context)`,
                context_window: m.maxContext ?? 1000000,
            });
        }
    }
    res.json({ object: 'list', data });
}
