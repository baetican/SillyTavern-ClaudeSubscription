import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyConfigIsolation, privateConfigDir, sweepPrivateTranscript } from '../lib/config-isolation.js';

test('isolation can be switched off', async () => {
    process.env.CLAUDE_SUBSCRIPTION_ISOLATE_CONFIG = '0';
    try {
        const env = {};
        assert.equal(await applyConfigIsolation(env, { apiKey: null }), null);
        assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    } finally {
        delete process.env.CLAUDE_SUBSCRIPTION_ISOLATE_CONFIG;
    }
});

test('API-key billing and caller tokens are isolated without reading credentials', async () => {
    const withKey = {};
    assert.equal(await applyConfigIsolation(withKey, { apiKey: 'sk-ant-test' }), privateConfigDir());
    assert.equal(withKey.CLAUDE_CONFIG_DIR, privateConfigDir());
    assert.equal(withKey.CLAUDE_CODE_OAUTH_TOKEN, undefined);

    const withToken = { CLAUDE_CODE_OAUTH_TOKEN: 'caller-token' };
    await applyConfigIsolation(withToken, { apiKey: null });
    assert.equal(withToken.CLAUDE_CODE_OAUTH_TOKEN, 'caller-token');
    assert.equal(withToken.CLAUDE_CONFIG_DIR, privateConfigDir());
});

test('sweep removes only the given session from every project bucket', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-iso-'));
    const bucket = join(dir, 'projects', 'scratch');
    mkdirSync(join(bucket, 'abc'), { recursive: true });
    writeFileSync(join(bucket, 'abc.jsonl'), '{}');
    writeFileSync(join(bucket, 'other.jsonl'), '{}');

    sweepPrivateTranscript(dir, 'abc');
    assert.ok(!existsSync(join(bucket, 'abc.jsonl')));
    assert.ok(!existsSync(join(bucket, 'abc')));
    assert.ok(existsSync(join(bucket, 'other.jsonl')));

    sweepPrivateTranscript(join(dir, 'missing'), 'abc'); // no projects dir → no throw
});
