import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractSettings } from '../lib/settings.js';
import { buildSdkOptions } from '../lib/chat.js';
import { parseModelRequest } from '../lib/models.js';

function optionsFor(claudeSubscription) {
    const settings = extractSettings({ claude_subscription: claudeSubscription });
    return buildSdkOptions({
        modelInfo: parseModelRequest('claude-sonnet-5-5'),
        oneMActive: false,
        settings,
        systemText: 'You are Aria.',
        abortController: new AbortController(),
        stream: true,
        env: {},
        resume: null,
    });
}

test('web search is off unless explicitly enabled', () => {
    assert.equal(extractSettings({}).webSearch, false);
    assert.equal(extractSettings({ claude_subscription: { web_search: 'true' } }).webSearch, false);
    assert.equal(extractSettings({ claude_subscription: { web_search: true } }).webSearch, true);
});

test('default options keep the no-tools isolation recipe', () => {
    const options = optionsFor({});
    assert.deepEqual(options.tools, []);
    assert.equal(options.allowedTools, undefined);
    assert.equal(options.maxTurns, 1);
    assert.equal(options.title, 'SillyTavern chat');
});

test('web search enables only the built-in WebSearch tool and raises the turn cap', () => {
    const options = optionsFor({ web_search: true });
    assert.deepEqual(options.tools, ['WebSearch']);
    assert.deepEqual(options.allowedTools, ['WebSearch']);
    assert.equal(options.maxTurns, 6); // 4 searches + 1 refused attempt + the reply
    assert.deepEqual(options.skills, []);
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.mcpServers, undefined);
});

test('the search budget hook allows four searches, then refuses with a reason', async () => {
    const { hooks } = optionsFor({ web_search: true });
    const [matcher] = hooks.PreToolUse;
    assert.equal(matcher.matcher, 'WebSearch');
    const run = () => matcher.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'WebSearch' }, 'toolu_x', { signal: new AbortController().signal });
    for (let i = 0; i < 4; i += 1) assert.deepEqual(await run(), {});
    const refused = await run();
    assert.equal(refused.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(refused.hookSpecificOutput.permissionDecisionReason, /Search limit reached/);
});

test('each request gets a fresh search budget', async () => {
    const first = optionsFor({ web_search: true }).hooks.PreToolUse[0].hooks[0];
    for (let i = 0; i < 5; i += 1) await first({}, undefined, {});
    const second = optionsFor({ web_search: true }).hooks.PreToolUse[0].hooks[0];
    assert.deepEqual(await second({}, undefined, {}), {});
});
