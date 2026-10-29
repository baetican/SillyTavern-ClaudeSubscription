// ──────────────────────────────────────────────
// Private CLAUDE_CONFIG_DIR for the SDK subprocess
// ──────────────────────────────────────────────
//
// Claude Code injects a `userEmail` context block into every request when
// ~/.claude.json carries `oauthAccount.emailAddress` (i.e. you ran `claude
// login`). No setting, SDK option or env var turns it off, and
// settingSources:[] doesn't touch it — verified live on CLI 2.1.312. For
// roleplay it's pure noise that skews short prompts.
//
// The fix: run the subprocess against a plugin-owned config dir that has no
// oauthAccount, and hand it the subscription access token through
// CLAUDE_CODE_OAUTH_TOKEN. The CLI never refreshes an env-supplied token,
// so the real ~/.claude/.credentials.json is never touched by it — the
// plugin keeps the token fresh itself (refreshOAuthToken, which re-reads
// before writing so it never clobbers a rotation by the real CLI).
//
// Side benefit: the subprocess also stops seeing ~/.claude memory, plugins
// and caches, and its live-turn transcripts land in the private dir.
//
// CLAUDE_SUBSCRIPTION_ISOLATE_CONFIG=0 restores the old behaviour.

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCredentials, refreshOAuthToken } from './oauth.js';

const PLUGIN_TAG = '[claude-subscription]';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cachedDir = null;
let warnedNoToken = false;

export function isolationEnabled() {
    return !/^(0|false|no|off)$/i.test(process.env.CLAUDE_SUBSCRIPTION_ISOLATE_CONFIG ?? '');
}

export function privateConfigDir() {
    if (cachedDir) return cachedDir;
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = resolve(here, '..', '.claude-config');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    cachedDir = dir;
    return dir;
}

/** A non-expired subscription access token, refreshing it if it's about to
 *  lapse. null when none is readable (e.g. macOS keychain-only logins). */
async function freshAccessToken() {
    let oauth = readCredentials()?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    const expiresAt = Number(oauth.expiresAt) || 0;
    if (expiresAt && expiresAt - Date.now() < REFRESH_MARGIN_MS && await refreshOAuthToken()) {
        oauth = readCredentials()?.claudeAiOauth ?? oauth;
    }
    return oauth.accessToken;
}

/**
 * Point the subprocess env at the private config dir. Returns the dir when
 * applied, null when isolation is off or no token could be supplied (the
 * subprocess then runs against the normal config, email and all).
 */
export async function applyConfigIsolation(env, { apiKey }) {
    if (!isolationEnabled()) return null;
    // API-key billing and a caller-supplied long-lived token need nothing
    // from the credentials file.
    if (!apiKey && !env.CLAUDE_CODE_OAUTH_TOKEN) {
        const token = await freshAccessToken();
        if (!token) {
            if (!warnedNoToken) {
                warnedNoToken = true;
                console.warn(`${PLUGIN_TAG} no readable OAuth token — running without config isolation (Claude Code will include your account email in prompts)`);
            }
            return null;
        }
        env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }
    const dir = privateConfigDir();
    env.CLAUDE_CONFIG_DIR = dir;
    return dir;
}

/** Delete a session's live-turn transcript from the private config dir.
 *  (The SDK's deleteSession only looks in this process's config dir.) */
export function sweepPrivateTranscript(configDir, sessionId) {
    const projects = join(configDir, 'projects');
    if (!existsSync(projects)) return;
    for (const bucket of readdirSync(projects)) {
        rmSync(join(projects, bucket, `${sessionId}.jsonl`), { force: true });
        rmSync(join(projects, bucket, sessionId), { recursive: true, force: true });
    }
}
