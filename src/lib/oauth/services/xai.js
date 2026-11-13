import { OAuthService } from "./oauth.js";
import crypto from "crypto";
import { XAI_CONFIG } from "../constants/xai.js";

/**
 * xAI (Grok) OAuth Service
 *
 * Source of truth: router-for-me/CLIProxyAPI internal/auth/xai/xai.go
 *
 * Flow:
 *  1. Discover endpoints from `${XAI_ISSUER}/.well-known/openid-configuration`
 *  2. Bind loopback server on 127.0.0.1:56121, path /callback
 *  3. PKCE S256 with 96-byte verifier
 *  4. Exchange code with form-urlencoded body
 *  5. id_token email decode (no signature verify, mirrors Go)
 */

const BASE64_BLOCK_SIZE = 4;

let cachedDiscovery = null;

export function validateOAuthEndpoint(rawUrl, field) {
  const value = String(rawUrl || "").trim();
  if (!value) throw new Error(`xai discovery ${field} is empty`);

  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    throw new Error(`xai discovery ${field} is invalid: ${err.message}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`xai discovery ${field} must use https: ${value}`);
  }

  const host = parsed.hostname.toLowerCase().trim();
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(`xai discovery ${field} host ${host} is not on x.ai`);
  }

  return value;
}

/**
 * Discover authorization + token endpoints. Cached process-wide.
 */
export async function discoverEndpoints() {
  if (cachedDiscovery) return cachedDiscovery;

  try {
    const res = await fetch(XAI_CONFIG.discoveryUrl, {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      cachedDiscovery = {
        authorizeUrl: validateOAuthEndpoint(data.authorization_endpoint, "authorization_endpoint"),
        tokenUrl: validateOAuthEndpoint(data.token_endpoint, "token_endpoint"),
      };
      return cachedDiscovery;
    }
  } catch {
    // fall through to static fallback
  }

  cachedDiscovery = {
    authorizeUrl: XAI_CONFIG.authorizeUrl,
    tokenUrl: XAI_CONFIG.tokenUrl,
  };
  return cachedDiscovery;
}

/**
 * Decode the `email` claim from an id_token JWT. No signature verification —
 * mirrors CLIProxyAPI Go behavior. Returns undefined if not parseable.
 */
export function decodeIdTokenEmail(idToken) {
  if (!idToken || typeof idToken !== "string") return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const json = Buffer.from(base64 + "=".repeat(padding), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload.email || payload.preferred_username || payload.sub || undefined;
  } catch {
    return undefined;
  }
}

export class XaiService extends OAuthService {
  constructor() {
    super(XAI_CONFIG);
  }

  /**
   * Build xAI authorization URL. Spaces in scope are encoded as %20.
   */
  buildXaiAuthUrl(redirectUri, state, codeChallenge, authorizeUrl) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const params = {
      response_type: "code",
      client_id: XAI_CONFIG.clientId,
      redirect_uri: redirectUri,
      scope: XAI_CONFIG.scope,
      code_challenge: codeChallenge,
      code_challenge_method: XAI_CONFIG.codeChallengeMethod,
      state,
      nonce,
      plan: "generic",
      referrer: "cli-proxy-api",
    };
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `${authorizeUrl}?${qs}`;
  }

  /**
   * Exchange authorization code for tokens.
   * xAI is a public PKCE client — no client_secret.
   */
  async exchangeXaiCode({ tokenUrl, code, redirectUri, codeVerifier }) {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: XAI_CONFIG.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`xAI token exchange failed: ${err}`);
    }
    return await res.json();
  }

  /**
   * Refresh an access token using a refresh_token.
   */
  async refreshAccessToken(refreshToken, proxyOptions = null) {
    const { tokenUrl } = await discoverEndpoints();
    // Dynamic import: proxyFetch patches globalThis.fetch at load; this module is
    // also imported by pure URL/discovery helpers that must not trigger that.
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
    const res = await proxyAwareFetch(
      tokenUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: XAI_CONFIG.clientId,
          refresh_token: refreshToken,
        }),
      },
      proxyOptions,
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`xAI token refresh failed: ${err}`);
    }
    return await res.json();
  }
}
