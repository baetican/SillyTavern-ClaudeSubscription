import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSystemPlacement } from '../lib/system-placement.js';
import { extractSystemText } from '../lib/system-prompt.js';
import { splitHistoryForResume, assembleEntries } from '../lib/jsonl-entries.js';
import { renderTranscript } from '../lib/transcript.js';
import { extractSettings } from '../lib/settings.js';

const NAMES = { userName: 'Mika', charName: 'Seraphina', groupNames: [] };
const META = { sessionId: 's', cwd: '/tmp', version: 'test', gitBranch: '', permissionMode: 'bypassPermissions' };

const sys = (content, name) => (name ? { role: 'system', content, name } : { role: 'system', content });
const user = (content) => ({ role: 'user', content });
const asst = (content) => ({ role: 'assistant', content });

// A typical preset: main prompt + card + examples above Chat History,
// Author's Note at depth and post-history instructions below it.
const PRESET = [
    sys('Main prompt.'),
    sys('Character card.'),
    sys('How are you?', 'example_user'),
    sys('Seraphina: Well, thank you.', 'example_assistant'),
    asst('Greeting.'),
    user('Hello.'),
    asst('Hi there.'),
    sys("[Author's note: keep it short]"),
    user('What now?'),
    sys('Post-history: stay in character.'),
];

test('leading system messages form the system prompt, in order, examples prefixed once', () => {
    const out = normalizeSystemPlacement(PRESET, NAMES);
    assert.equal(
        extractSystemText(out),
        'Main prompt.\n\nCharacter card.\n\nMika: How are you?\n\nSeraphina: Well, thank you.',
    );
    assert.equal(out.filter((m) => m.role === 'system').length, 4);
    // Input untouched.
    assert.equal(PRESET[2].content, 'How are you?');
});

test('late system messages become user text merged where the preset put them', () => {
    const out = normalizeSystemPlacement(PRESET, NAMES);
    const split = splitHistoryForResume(out);
    assert.equal(split.shape, 'trailing-user');
    assert.equal(split.current.content, "[Author's note: keep it short]\n\nWhat now?\n\nPost-history: stay in character.");
    assert.ok(!extractSystemText(out).includes('Post-history'));
    assert.deepEqual(split.history.map((m) => m.role), ['assistant', 'user', 'assistant']);

    const entries = assembleEntries(split.history, META, 'claude-test');
    assert.deepEqual(entries.map((e) => e.type), ['assistant', 'user', 'assistant']);
});

test('a system message between assistant turns becomes its own user turn', () => {
    const out = normalizeSystemPlacement([sys('S'), user('u'), asst('a1'), sys('Depth WI'), asst('a2'), user('u2')], NAMES);
    assert.deepEqual(out.map((m) => [m.role, m.content]), [
        ['system', 'S'], ['user', 'u'], ['assistant', 'a1'], ['user', 'Depth WI'], ['assistant', 'a2'], ['user', 'u2'],
    ]);
    assert.ok(!('name' in out[3]));
});

test('requests whose adjacent user turns had no system message between them keep them separate', () => {
    const out = normalizeSystemPlacement([sys('S'), user('a'), user('b')], NAMES);
    assert.equal(out.length, 3);
});

test('merging into a user message with an image keeps the image part', () => {
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const out = normalizeSystemPlacement([sys('S'), user([{ type: 'text', text: 'Look' }, img]), sys('Post')], NAMES);
    assert.equal(out.length, 2);
    assert.deepEqual(out[1].content, [{ type: 'text', text: 'Look' }, img, { type: 'text', text: 'Post' }]);
});

test('late examples are prefixed too, and never twice', () => {
    const out = normalizeSystemPlacement([
        sys('S'), user('u'),
        sys('Mika: already prefixed', 'example_user'),
        sys('reply', 'example_assistant'),
    ], NAMES);
    assert.equal(out[1].content, 'u\n\nMika: already prefixed\n\nSeraphina: reply');
});

test('group names count as an existing assistant prefix', () => {
    const out = normalizeSystemPlacement(
        [sys('Lilia: hi', 'example_assistant')],
        { ...NAMES, groupNames: ['Lilia'] },
    );
    assert.equal(out[0].content, 'Lilia: hi');
});

test('a trailing assistant prefill still takes the continuation path', () => {
    const out = normalizeSystemPlacement([sys('S'), user('Go.'), sys('Post'), asst('Prefill')], NAMES);
    const split = splitHistoryForResume(out);
    assert.equal(split.shape, 'trailing-assistant-continue');
    assert.deepEqual(split.history, [{ role: 'user', content: 'Go.\n\nPost' }]);
    assert.match(split.current.content, /<assistant_prefill>\nPrefill\n<\/assistant_prefill>/);
});

test('the fold path gets the same system / turn split', () => {
    const out = normalizeSystemPlacement(PRESET, NAMES);
    const fold = renderTranscript(out);
    assert.equal(fold.systemPrompt, extractSystemText(out));
    assert.ok(fold.prompt.endsWith('User: [Author\'s note: keep it short]\n\nWhat now?\n\nPost-history: stay in character.'));
});

test('system-only input still yields the synthetic start turn', () => {
    const out = normalizeSystemPlacement([sys('ping')], NAMES);
    assert.equal(splitHistoryForResume(out).shape, 'synthetic-start');
    assert.equal(renderTranscript(out).prompt, 'User: [Start]');
});

test('blank late system messages are dropped', () => {
    const out = normalizeSystemPlacement([sys('S'), user('u'), sys('   ')], NAMES);
    assert.deepEqual(out.map((m) => m.content), ['S', 'u']);
});

test('"all" reproduces the previous behaviour exactly', () => {
    const out = normalizeSystemPlacement(PRESET, NAMES, 'all');
    assert.equal(out, PRESET);
    assert.equal(
        extractSystemText(out),
        "Main prompt.\n\nCharacter card.\n\nHow are you?\n\nSeraphina: Well, thank you.\n\n[Author's note: keep it short]\n\nPost-history: stay in character.",
    );
});

test('settings parse placement and relayed names', () => {
    const s = extractSettings({ claude_subscription: { system_placement: 'all', user_name: 'Mika', char_name: 'Sera', group_names: ['A', 3] } });
    assert.equal(s.systemPlacement, 'all');
    assert.deepEqual(s.names, { userName: 'Mika', charName: 'Sera', groupNames: ['A'] });

    const d = extractSettings({ user_name: 'Top', claude_subscription: { system_placement: 'bogus' } });
    assert.equal(d.systemPlacement, 'leading');
    assert.equal(d.names.userName, 'Top');
});
