import test from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_SUBSCRIPTION_KEY = 'csp-test-key';
const { makeHostGuard, requireProxyKey, getProxyKey } = await import('../lib/auth.js');

function mockRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

function run(mw, req) {
    const res = mockRes();
    let passed = false;
    mw(req, res, () => { passed = true; });
    return { passed, res };
}

test('host guard accepts loopback and the bind host, rejects others', () => {
    const guard = makeHostGuard('127.0.0.1');
    for (const host of ['127.0.0.1:8901', 'localhost:8901', '[::1]:8901', 'LOCALHOST']) {
        assert.equal(run(guard, { headers: { host } }).passed, true, host);
    }
    for (const host of ['evil.example:8901', 'rebind.attacker.test', '', undefined]) {
        const { passed, res } = run(guard, { headers: { host } });
        assert.equal(passed, false, String(host));
        assert.equal(res.statusCode, 403);
    }

    const lan = makeHostGuard('192.168.1.10');
    assert.equal(run(lan, { headers: { host: '192.168.1.10:8901' } }).passed, true);

    const wildcard = makeHostGuard('0.0.0.0');
    assert.equal(run(wildcard, { headers: { host: '0.0.0.0:8901' } }).passed, false);
});

test('proxy key is required via body namespace or bearer header', () => {
    assert.equal(getProxyKey(), 'csp-test-key');
    const req = (body, auth) => ({ body, get: (h) => (h.toLowerCase() === 'authorization' ? auth : undefined) });

    assert.equal(run(requireProxyKey, req({ claude_subscription: { proxy_key: 'csp-test-key' } })).passed, true);
    assert.equal(run(requireProxyKey, req({}, 'Bearer csp-test-key')).passed, true);
    // API-billing users: sk-ant key in the header, proxy key in the body.
    assert.equal(run(requireProxyKey, req({ claude_subscription: { proxy_key: 'csp-test-key' } }, 'Bearer sk-ant-xyz')).passed, true);

    for (const r of [req({}), req({}, 'Bearer sk-no-key-needed'), req({ claude_subscription: { proxy_key: 'wrong' } })]) {
        const { passed, res } = run(requireProxyKey, r);
        assert.equal(passed, false);
        assert.equal(res.statusCode, 401);
    }
});
