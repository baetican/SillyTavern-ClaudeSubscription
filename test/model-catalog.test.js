import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeApiModel, __setLiveCatalogForTesting, refreshModelCatalog } from '../lib/model-catalog.js';
import {
    parseModelRequest,
    resolveThinkingMode,
    resolveEffort,
    canonicalTierModels,
    listModelsHandler,
    CANONICAL_TIER_MODELS,
} from '../lib/models.js';

process.env.CLAUDE_SUBSCRIPTION_STATIC_MODELS = '1';

const ALL_EFFORTS = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } };

// Shapes copied from a live GET /v1/models response (capabilities trimmed).
function apiModel(id, line, created, { maxInput = 1000000, thinking, effort = ALL_EFFORTS, lifecycle = 'active' } = {}) {
    return {
        type: 'model',
        id,
        display_name: id.replace(/^claude-/, 'Claude ').replace(/-/g, ' '),
        created_at: created,
        line,
        max_input_tokens: maxInput,
        max_tokens: 128000,
        capabilities: { effort, thinking: { supported: true, types: thinking } },
        lifecycle,
    };
}
const T = (adaptive, enabled, disabled) => ({
    adaptive: { supported: adaptive }, enabled: { supported: enabled }, disabled: { supported: disabled },
});

const FIXTURE = [
    apiModel('claude-haiku-5-5', 'haiku', '2026-10-07T18:00:00Z', { thinking: T(true, false, true) }),
    apiModel('claude-sonnet-5-5', 'sonnet', '2026-09-28T00:00:00Z', { thinking: T(true, false, false) }),
    apiModel('claude-opus-5-5', 'opus', '2026-09-21T16:24:00Z', { thinking: T(true, false, false) }),
    apiModel('claude-opus-5', 'opus', '2026-07-24T00:00:00Z', { thinking: T(true, false, true) }),
    apiModel('claude-sonnet-4-6', 'sonnet', '2026-02-17T00:00:00Z', {
        thinking: T(true, true, true),
        effort: { ...ALL_EFFORTS, xhigh: { supported: false } },
    }),
    apiModel('claude-haiku-4-5-20251001', 'haiku', '2025-10-15T00:00:00Z', {
        maxInput: 200000,
        thinking: T(false, true, true),
        effort: { supported: false },
    }),
    apiModel('claude-old-retired', 'opus', '2024-01-01T00:00:00Z', { thinking: T(false, true, true), lifecycle: 'retired' }),
].filter((m) => m.lifecycle === 'active').map(normalizeApiModel);

test('normalizeApiModel derives tier, 1M eligibility, thinking and effort capabilities', () => {
    const haiku55 = FIXTURE.find((m) => m.id === 'claude-haiku-5-5');
    assert.equal(haiku55.tier, 'haiku');
    assert.equal(haiku55.oneM, true);
    assert.equal(haiku55.context, 200000);
    assert.equal(haiku55.maxContext, 1000000);
    assert.deepEqual(haiku55.thinkingTypes, { adaptive: true, enabled: false, disabled: true });
    assert.deepEqual(haiku55.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);

    const haiku45 = FIXTURE.find((m) => m.id === 'claude-haiku-4-5-20251001');
    assert.equal(haiku45.oneM, false);
    assert.equal(haiku45.efforts, null);
});

test('live catalog drives the picker, canonical pins and request parsing', async () => {
    __setLiveCatalogForTesting(FIXTURE);
    try {
        let payload = null;
        await listModelsHandler({}, { json(p) { payload = p; } });
        const ids = payload.data.map((m) => m.id);
        assert.ok(ids.includes('claude-opus-5-5'));
        assert.ok(ids.includes('claude-opus-5-5[1m]'));
        assert.ok(ids.includes('claude-haiku-4-5-20251001'));
        assert.ok(!ids.includes('claude-haiku-4-5-20251001[1m]'));
        assert.ok(!ids.includes('claude-fable-5-1'), 'static entries are not mixed into a live list');
        assert.equal(payload.data.find((m) => m.id === 'claude-opus-5-5[1m]').context_window, 1000000);

        // Newest per tier from the live list; tiers absent live keep the static pin.
        const pins = canonicalTierModels();
        assert.equal(pins.opus, 'claude-opus-5-5');
        assert.equal(pins.sonnet, 'claude-sonnet-5-5');
        assert.equal(pins.haiku, 'claude-haiku-5-5');
        assert.equal(pins.fable, CANONICAL_TIER_MODELS.fable);

        const opus55 = parseModelRequest('claude-opus-5.5[1m]');
        assert.equal(opus55.baseId, 'claude-opus-5-5');
        assert.equal(opus55.oneM, true);
        assert.equal(opus55.sdkModel, 'opus[1m]');
        assert.equal(opus55.envPins.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5-5');

        // Static fallback still resolves IDs the live list spells differently.
        assert.equal(parseModelRequest('claude-fable-5-1').tier, 'fable');
    } finally {
        __setLiveCatalogForTesting(null);
    }
});

test('thinking mode maps onto supported types', () => {
    __setLiveCatalogForTesting(FIXTURE);
    try {
        const haiku55 = parseModelRequest('claude-haiku-5-5');
        assert.equal(resolveThinkingMode(haiku55, 'off'), 'disabled');   // supported → honoured
        assert.equal(resolveThinkingMode(haiku55, 'on'), 'adaptive');    // no budgeted mode

        const sonnet55 = parseModelRequest('claude-sonnet-5-5');
        assert.equal(resolveThinkingMode(sonnet55, 'off'), 'adaptive');  // can't disable
        assert.equal(sonnet55.adaptiveOnly, true);

        const opus5 = parseModelRequest('claude-opus-5');
        assert.equal(resolveThinkingMode(opus5, 'off'), 'disabled');     // was ignored by the old heuristic

        const sonnet46 = parseModelRequest('claude-sonnet-4-6');
        assert.equal(resolveThinkingMode(sonnet46, 'on'), 'enabled');

        const haiku45 = parseModelRequest('claude-haiku-4-5-20251001');
        assert.equal(resolveThinkingMode(haiku45, 'adaptive'), 'enabled');
        assert.equal(resolveThinkingMode(haiku45, 'off'), 'disabled');
    } finally {
        __setLiveCatalogForTesting(null);
    }
});

test('effort is clamped to supported levels', () => {
    __setLiveCatalogForTesting(FIXTURE);
    try {
        const sonnet46 = parseModelRequest('claude-sonnet-4-6');
        assert.equal(resolveEffort(sonnet46, 'xhigh'), 'high');
        assert.equal(resolveEffort(sonnet46, 'max'), 'max');
        assert.equal(resolveEffort(parseModelRequest('claude-haiku-4-5-20251001'), 'high'), undefined);
        assert.equal(resolveEffort(parseModelRequest('claude-opus-5-5'), undefined), undefined);
        // Unknown model → passed through untouched.
        assert.equal(resolveEffort(parseModelRequest('claude-future-9'), 'xhigh'), 'xhigh');
    } finally {
        __setLiveCatalogForTesting(null);
    }
});

test('static mode never fetches', async () => {
    __setLiveCatalogForTesting(null);
    assert.equal(await refreshModelCatalog({ force: true }), null);
});
