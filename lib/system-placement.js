// ──────────────────────────────────────────────
// System-message placement (SillyTavern's Claude mapping)
// ──────────────────────────────────────────────
//
// The Agent SDK has one systemPrompt and a user/assistant session — no
// system role mid-conversation. Pulling EVERY system message into the
// systemPrompt (the pre-2.3 behaviour) hoists post-history instructions,
// Author's Note, World Info at depth and in-chat extension prompts above
// the entire history, and a per-turn change in any of them invalidates the
// prompt cache from the very first block.
//
// 'leading' (default) mirrors SillyTavern's own Claude converter with "Use
// system prompt" on (convertClaudeMessages, src/prompt-converters.js) and
// its "Semi-strict" post-processing for Custom sources:
//   • the leading run of system messages stays system;
//   • every later system message becomes a user message, merged into the
//     neighbouring user turn — so post-history instructions arrive as the
//     tail of the final user turn, the last thing the model reads;
//   • dialogue examples (name: example_user / example_assistant) get the
//     "{{user}}: " / "{{char}}: " prefix ST adds, never twice.
// Idempotent with ST's Semi-strict mode: already-converted input passes
// through unchanged.
//
// 'all' keeps the old behaviour (every system message → systemPrompt).

export const VALID_PLACEMENTS = ['leading', 'all'];

function startsWithGroupName(text, names) {
    return (names.groupNames ?? []).some((n) => text.startsWith(`${n}: `));
}

function prefixText(text, message, names) {
    if (typeof text !== 'string') return text;
    if (message.name === 'example_user' && names.userName && !text.startsWith(`${names.userName}: `)) {
        return `${names.userName}: ${text}`;
    }
    if (message.name === 'example_assistant' && names.charName
        && !text.startsWith(`${names.charName}: `) && !startsWithGroupName(text, names)) {
        return `${names.charName}: ${text}`;
    }
    return text;
}

/** Apply the example-dialogue prefix to a system message (string or the
 *  first text part of a multi-part array). */
function prefixExample(message, names) {
    if (message.name !== 'example_user' && message.name !== 'example_assistant') return message;
    if (typeof message.content === 'string') {
        return { ...message, content: prefixText(message.content, message, names) };
    }
    if (Array.isArray(message.content)) {
        const i = message.content.findIndex((p) => p?.type === 'text' && typeof p.text === 'string');
        if (i === -1) return message;
        const content = message.content.slice();
        content[i] = { ...content[i], text: prefixText(content[i].text, message, names) };
        return { ...message, content };
    }
    return message;
}

function hasText(content) {
    if (typeof content === 'string') return content.trim() !== '';
    if (Array.isArray(content)) {
        return content.some((p) => p && (p.type !== 'text' || (typeof p.text === 'string' && p.text.trim() !== '')));
    }
    return false;
}

function toParts(content) {
    if (Array.isArray(content)) return content;
    return typeof content === 'string' && content !== '' ? [{ type: 'text', text: content }] : [];
}

/** Join two contents: strings with a blank line; otherwise concatenate the
 *  part arrays so image_url parts survive. */
function mergeContent(a, b) {
    if (typeof a === 'string' && typeof b === 'string') {
        return a && b ? `${a}\n\n${b}` : (a || b);
    }
    return [...toParts(a), ...toParts(b)];
}

/**
 * @param {object[]} messages OpenAI chat messages (not mutated)
 * @param {{ userName?: string, charName?: string, groupNames?: string[] }} names
 * @param {'leading'|'all'} mode
 * @returns {object[]}
 */
export function normalizeSystemPlacement(messages, names = {}, mode = 'leading') {
    if (mode === 'all' || !Array.isArray(messages)) return messages;

    let i = 0;
    const out = [];
    for (; i < messages.length && messages[i]?.role === 'system'; i++) {
        out.push(prefixExample(messages[i], names));
    }

    // Messages produced by (or merged with) a converted system message.
    // Only those merge — user turns that were already adjacent in the
    // request stay separate entries, as before.
    const converted = new WeakSet();
    for (; i < messages.length; i++) {
        const m = messages[i];
        if (!m) continue;
        let msg = m;
        let isConverted = false;
        if (m.role === 'system') {
            if (!hasText(m.content)) continue;
            const { name: _name, ...rest } = prefixExample(m, names);
            msg = { ...rest, role: 'user' };
            isConverted = true;
        }
        const prev = out[out.length - 1];
        // prev.role === 'user' never matches a leading system message, and
        // tool messages / tool-call turns have other roles, so neither is
        // ever merged across.
        if (prev && prev.role === 'user' && msg.role === 'user'
            && (isConverted || converted.has(prev))) {
            const merged = { ...prev, content: mergeContent(prev.content, msg.content) };
            converted.add(merged);
            out[out.length - 1] = merged;
            continue;
        }
        if (isConverted) converted.add(msg);
        out.push(msg);
    }
    return out;
}
