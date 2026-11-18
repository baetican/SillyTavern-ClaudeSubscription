#!/usr/bin/env node
// ──────────────────────────────────────────────
// Probe: OpenAI-style tool-call passthrough via the Agent SDK
// ──────────────────────────────────────────────
//
// Live checks (these use your subscription) for the assumptions that tool
// passthrough depends on, run against the plugin's real env/isolation setup:
//
//   passthrough      Client tool exposed via an in-process MCP server with a
//                    raw JSON Schema. Does the model call it, do tool_use
//                    stream events arrive, and does aborting on the finished
//                    assistant message stop the turn cleanly before the
//                    handler runs?
//   noabort          Same, but lets the CLI run its own loop (maxTurns 1) to
//                    show what it does when the turn isn't cut short.
//   replay           Round trip: history holding an assistant tool_use plus
//                    the tool result, replayed through the resume path. Does
//                    the model answer from the injected result?
//   replay-parallel  Same with two parallel calls. Only the last tool message
//                    becomes the prompt; the other lands in history.
//   builtin          The CLI's own WebSearch tool instead of a client tool.
//
// Usage:
//   node scripts/probe-tools.mjs <scenario|all> [--model id] [--capture dir]
//
// --capture routes the CLI through a local logging proxy (ANTHROPIC_BASE_URL)
// and writes each /v1/messages request BODY to <dir>, so the exact system
// prompt and tool list the API receives can be inspected. Headers (which
// carry the OAuth token) are never written.

import http from 'node:http';
import https from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { buildSubprocessEnv } from '../lib/env.js';
import { applyConfigIsolation } from '../lib/config-isolation.js';
import { assembleEntries, splitHistoryForResume, currentToSdkUserMessage, singleMessageStream, SDK_VERSION } from '../lib/jsonl-entries.js';
import { ResumeSessionStore, resumeScratchCwd } from '../lib/session-store.js';

// ── CLI args ────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const scenarioArg = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true) ?? 'passthrough';
const MODEL = flag('--model') ?? 'claude-sonnet-5-5';
const CAPTURE_DIR = flag('--capture');

const SERVER_NAME = 'st';
const PREFIX = `mcp__${SERVER_NAME}__`;

// Mirrors the function tool SillyTavern's official Web Search extension
// registers (sent by SillyTavern as an OpenAI `tools[]` entry).
const ST_TOOLS = [{
    type: 'function',
    function: {
        name: 'WebSearch',
        description: 'Search the web and get the content of the relevant pages. Search for unknown knowledge, public personalities, up-to-date information, weather, news, etc.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: { query: { type: 'string', description: 'The query to search for.' } },
            required: ['query'],
        },
    },
}];

const SYSTEM = [
    'You are Aria, a cheerful research assistant character in an ongoing chat.',
    'Stay in character. When the user asks about current events or facts you are unsure of, use the WebSearch tool.',
].join('\n');

// ── Logging ─────────────────────────────────────
const t0 = Date.now();
const log = (...a) => console.log(`[+${String(Date.now() - t0).padStart(6)}ms]`, ...a);
const trunc = (s, n = 160) => {
    const str = typeof s === 'string' ? s : JSON.stringify(s);
    return str.length > n ? str.slice(0, n) + '…' : str;
};

// ── Client-tool MCP server (raw JSON Schema, no Zod) ──
function makeToolServer(openAiTools, handlerLog) {
    const server = new Server({ name: SERVER_NAME, version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: openAiTools.map((t) => {
            // MCP clients expect a plain object schema; $schema is harmless
            // but strip it to match what the plugin would send.
            const { $schema, ...inputSchema } = t.function.parameters ?? { type: 'object', properties: {} };
            return { name: t.function.name, description: t.function.description ?? '', inputSchema };
        }),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        handlerLog.push(req.params);
        log('!! HANDLER CALLED', req.params.name, trunc(req.params.arguments));
        return { content: [{ type: 'text', text: 'Search backend unavailable in probe.' }], isError: true };
    });
    return { type: 'sdk', name: SERVER_NAME, instance: server, alwaysLoad: true };
}

// ── Optional logging proxy ──────────────────────
async function startCaptureProxy(dir) {
    mkdirSync(dir, { recursive: true });
    let n = 0;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            if (req.url?.startsWith('/v1/messages') && body.length) {
                n += 1;
                const file = join(dir, `${String(n).padStart(2, '0')}-${scenarioArg}-${req.url.replace(/[^a-z0-9]+/gi, '_')}.json`);
                try {
                    writeFileSync(file, JSON.stringify(JSON.parse(body.toString('utf8')), null, 2));
                } catch {
                    writeFileSync(file, body);
                }
                log(`   capture → ${file}`);
            }
            const headers = { ...req.headers, host: 'api.anthropic.com' };
            const up = https.request({ host: 'api.anthropic.com', port: 443, method: req.method, path: req.url, headers }, (upRes) => {
                res.writeHead(upRes.statusCode ?? 502, upRes.headers);
                upRes.pipe(res);
            });
            up.on('error', (err) => {
                res.writeHead(502);
                res.end(String(err));
            });
            up.end(body);
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    log(`capture proxy on http://127.0.0.1:${port} → ${dir}`);
    return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// ── Shared options (mirrors lib/chat.js buildSdkOptions) ──
async function baseOptions({ abortController, proxyUrl, resume }) {
    const env = buildSubprocessEnv({ envPins: {}, maxTokens: 8192, apiKey: null });
    const configDir = await applyConfigIsolation(env, { apiKey: null });
    log(`config isolation: ${configDir ? 'on' : 'OFF (no readable token)'}`);
    if (proxyUrl) env.ANTHROPIC_BASE_URL = proxyUrl;
    // --env K=V (repeatable): extra subprocess env for A/B checks.
    args.forEach((a, i) => {
        if (a !== '--env') return;
        const [k, ...v] = String(args[i + 1] ?? '').split('=');
        if (k) env[k] = v.join('=');
    });
    const options = {
        abortController,
        model: MODEL,
        systemPrompt: SYSTEM,
        includePartialMessages: true,
        env,
        tools: [],
        skills: [],
        settingSources: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'low',
        cwd: resume?.cwd ?? resumeScratchCwd(),
    };
    if (resume) {
        options.resume = resume.sessionId;
        options.sessionStore = resume.store;
    }
    // Matches lib/chat.js (skips the title side-request); --title overrides.
    options.title = flag('--title') ?? 'SillyTavern chat';
    return options;
}

// ── Event tap ───────────────────────────────────
/**
 * Iterate a query, logging a compact trace. `onAssistant` may return true to
 * request an abort (the passthrough interception point).
 */
async function drive(handle, { abortController, onAssistant }) {
    const out = { text: '', toolUses: [], streamedToolUses: [], resultSubtype: null, error: null, abortedAt: null, sawToolResult: false };
    const deltaCounts = {};
    let current = null; // tool_use being assembled from stream events
    try {
        for await (const m of handle) {
            if (m.type === 'system' && m.subtype === 'init') {
                log('init', { model: m.model, tools: m.tools, mcp_servers: m.mcp_servers });
            } else if (m.type === 'stream_event') {
                const ev = m.event;
                if (ev.type === 'content_block_start') {
                    const b = ev.content_block;
                    log(`stream content_block_start[${ev.index}] ${b.type}${b.name ? ' name=' + b.name : ''}${b.id ? ' id=' + b.id : ''}`);
                    if (b.type === 'tool_use') current = { index: ev.index, id: b.id, name: b.name, json: '' };
                } else if (ev.type === 'content_block_delta') {
                    deltaCounts[ev.delta.type] = (deltaCounts[ev.delta.type] ?? 0) + 1;
                    if (ev.delta.type === 'text_delta') out.text += ev.delta.text;
                    if (ev.delta.type === 'input_json_delta' && current?.index === ev.index) current.json += ev.delta.partial_json;
                } else if (ev.type === 'content_block_stop') {
                    if (current?.index === ev.index) {
                        log(`stream tool_use complete ${current.name} args=${trunc(current.json)}`);
                        out.streamedToolUses.push(current);
                        current = null;
                    }
                } else if (ev.type === 'message_delta') {
                    log(`stream message_delta stop_reason=${ev.delta?.stop_reason}`);
                }
            } else if (m.type === 'assistant') {
                const blocks = m.message?.content ?? [];
                log('assistant', blocks.map((b) => b.type + (b.name ? `(${b.name})` : '')).join(', '), m.error ? `ERROR=${m.error}` : '');
                for (const b of blocks) if (b.type === 'tool_use') out.toolUses.push(b);
                if (onAssistant?.(m) && !abortController.signal.aborted) {
                    out.abortedAt = Date.now() - t0;
                    log('>> aborting (tool call intercepted)');
                    abortController.abort();
                }
            } else if (m.type === 'user') {
                const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
                const tr = blocks.filter((b) => b.type === 'tool_result');
                if (tr.length) {
                    out.sawToolResult = true;
                    log('user tool_result(s) from CLI loop:', tr.map((b) => trunc(b.content, 120)).join(' | '));
                }
            } else if (m.type === 'result') {
                out.resultSubtype = m.subtype;
                log('result', m.subtype, m.errors ? trunc(m.errors) : '', 'usage', trunc(m.usage, 200));
            }
        }
    } catch (err) {
        out.error = `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
        log('iteration threw:', out.error);
    }
    log('delta counts', deltaCounts);
    return out;
}

// ── Scenarios ───────────────────────────────────
async function scenarioPassthrough({ proxyUrl, abort }) {
    const abortController = new AbortController();
    const handlerLog = [];
    const options = await baseOptions({ abortController, proxyUrl });
    options.mcpServers = { [SERVER_NAME]: makeToolServer(ST_TOOLS, handlerLog) };
    options.allowedTools = ST_TOOLS.map((t) => PREFIX + t.function.name);
    const prompt = 'Hey Aria! Can you look up who won the most recent Formula 1 World Drivers\' Championship?';
    const out = await drive(query({ prompt, options }), {
        abortController,
        onAssistant: (m) => abort && (m.message?.content ?? []).some((b) => b.type === 'tool_use' && b.name.startsWith(PREFIX)),
    });
    // Give a straggling handler call a moment to show up after the abort.
    await new Promise((r) => setTimeout(r, 1500));
    return {
        modelCalledTool: out.toolUses.length > 0,
        toolNames: out.toolUses.map((b) => b.name),
        toolIds: out.toolUses.map((b) => b.id),
        argsFromAssistant: out.toolUses.map((b) => b.input),
        argsFromStream: out.streamedToolUses.map((t) => t.json),
        preToolText: trunc(out.text, 300),
        handlerCalls: handlerLog.length,
        cliRanToolLoop: out.sawToolResult,
        resultSubtype: out.resultSubtype,
        error: out.error,
    };
}

function replayMessages(parallel) {
    const marker = 'Pebble the marmot';
    const messages = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'Hey Aria! Who won the 2026 Tallinn Marmot Festival? And what\'s the weather there today?' },
        {
            role: 'assistant',
            content: 'Ooh, let me check!',
            tool_calls: [
                { id: 'toolu_probe0001', type: 'function', function: { name: PREFIX + 'WebSearch', arguments: JSON.stringify({ query: '2026 Tallinn Marmot Festival winner' }) } },
                ...(parallel ? [{ id: 'toolu_probe0002', type: 'function', function: { name: PREFIX + 'WebSearch', arguments: JSON.stringify({ query: 'Tallinn weather today' }) } }] : []),
            ],
        },
        { role: 'tool', tool_call_id: 'toolu_probe0001', content: `Tallinn Marmot Festival 2026 — results: first place went to ${marker}, who completed the burrow sprint in 41 seconds.` },
    ];
    if (parallel) {
        messages.push({ role: 'tool', tool_call_id: 'toolu_probe0002', content: 'Tallinn today: light snow, -3°C, wind 12 km/h from the northwest.' });
    }
    return { messages, marker };
}

/** Candidate fix: trailing tool results stay in the JSONL history (so the
 *  session never ends on an unresolved tool_use) and the prompt is a short
 *  continuation nudge instead. */
function splitToolResultsIntoHistory(messages) {
    const nonSystem = messages.filter((m) => m.role !== 'system');
    return { history: nonSystem, current: { role: 'user', content: CONTINUE_PROMPT }, shape: 'trailing-tool-in-history' };
}
const CONTINUE_PROMPT = flag('--continue-prompt') ?? 'Continue.';

async function scenarioReplay({ proxyUrl, parallel, fixed = false }) {
    const abortController = new AbortController();
    const handlerLog = [];
    const { messages, marker } = replayMessages(parallel);
    const split = fixed ? splitToolResultsIntoHistory(messages) : splitHistoryForResume(messages);
    const sessionId = randomUUID();
    const cwd = resumeScratchCwd();
    const entries = assembleEntries(split.history, { sessionId, cwd, version: SDK_VERSION, gitBranch: '', permissionMode: 'bypassPermissions' }, MODEL);
    log(`replay shape=${split.shape} historyEntries=${entries.length} (${entries.map((e) => e.type).join(',')})`);
    const resume = { sessionId, store: new ResumeSessionStore(sessionId, entries), cwd };
    const options = await baseOptions({ abortController, proxyUrl, resume });
    options.mcpServers = { [SERVER_NAME]: makeToolServer(ST_TOOLS, handlerLog) };
    options.allowedTools = ST_TOOLS.map((t) => PREFIX + t.function.name);
    const out = await drive(query({ prompt: singleMessageStream(currentToSdkUserMessage(split.current)), options }), { abortController });
    return {
        shape: split.shape,
        usedFirstResult: out.text.includes('Pebble'),
        usedSecondResult: parallel ? /snow|-3/i.test(out.text) : undefined,
        calledToolAgain: out.toolUses.length > 0,
        reply: trunc(out.text, 400),
        resultSubtype: out.resultSubtype,
        error: out.error,
        marker,
    };
}

async function scenarioBuiltin({ proxyUrl }) {
    const abortController = new AbortController();
    const options = await baseOptions({ abortController, proxyUrl });
    options.tools = ['WebSearch'];
    options.allowedTools = ['WebSearch'];
    options.maxTurns = 4;
    const prompt = 'Hey Aria! Can you look up who won the most recent Formula 1 World Drivers\' Championship?';
    const out = await drive(query({ prompt, options }), { abortController });
    return {
        toolNames: out.toolUses.map((b) => b.name),
        cliRanToolLoop: out.sawToolResult,
        reply: trunc(out.text, 400),
        resultSubtype: out.resultSubtype,
        error: out.error,
    };
}

/** Baseline: the plugin's current no-tools options, for diffing what the
 *  CLI adds to the request once tools are switched on. */
async function scenarioNoTools({ proxyUrl }) {
    const abortController = new AbortController();
    const options = await baseOptions({ abortController, proxyUrl });
    const out = await drive(query({ prompt: 'Hey Aria! How are you today?', options }), { abortController });
    return { reply: trunc(out.text, 200), resultSubtype: out.resultSubtype, error: out.error };
}

const SCENARIOS = {
    passthrough: (ctx) => scenarioPassthrough({ ...ctx, abort: true }),
    noabort: (ctx) => scenarioPassthrough({ ...ctx, abort: false }),
    replay: (ctx) => scenarioReplay({ ...ctx, parallel: false }),
    'replay-parallel': (ctx) => scenarioReplay({ ...ctx, parallel: true }),
    'replay-fixed': (ctx) => scenarioReplay({ ...ctx, parallel: true, fixed: true }),
    builtin: (ctx) => scenarioBuiltin(ctx),
    notools: (ctx) => scenarioNoTools(ctx),
};

// ── Main ────────────────────────────────────────
const names = scenarioArg === 'all' ? Object.keys(SCENARIOS) : [scenarioArg];
for (const n of names) {
    if (!SCENARIOS[n]) {
        console.error(`unknown scenario "${n}" — one of: all, ${Object.keys(SCENARIOS).join(', ')}`);
        process.exit(2);
    }
}

const proxy = CAPTURE_DIR ? await startCaptureProxy(CAPTURE_DIR) : null;
const summary = {};
for (const n of names) {
    console.log(`\n════════ ${n} (model ${MODEL}, SDK ${SDK_VERSION}) ════════`);
    try {
        summary[n] = await SCENARIOS[n]({ proxyUrl: proxy?.url });
    } catch (err) {
        summary[n] = { fatal: err instanceof Error ? err.stack : String(err) };
    }
    console.log(`── ${n} summary ──\n${JSON.stringify(summary[n], null, 2)}`);
}
proxy?.close();
process.exit(0);
