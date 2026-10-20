// Fable rationing (JP, 2026-10-11): "you and my claudes should use fable".
//
// Fable is one instance of the per-family policy in family-policy.js, which
// holds the semantics and the enforcement. These are the Fable-named entry
// points the proxy and its tests have always used.

import {
  SHARED_KEY_ENTRY, DEFAULT_DECODED_MAX, familyPolicy, clientAllowed, decideFamily,
  rewriteFamilyBody, familyModelIn, isFamilyModel, FamilyStats,
} from './family-policy.js';

export { SHARED_KEY_ENTRY, DEFAULT_DECODED_MAX, clientAllowed };
export const DEFAULT_FABLE_MODEL = 'claude-opus-5-5';

/** The first Fable model a body asks for anywhere (decoded, parsed, every `model` key), or null. @param {Buffer} body @param {string|string[]|undefined|null} [contentEncoding] @param {number} [maxBytes] @param {string|string[]|undefined|null} [contentType] */
export function fableModelIn(body, contentEncoding = null, maxBytes = DEFAULT_DECODED_MAX, contentType = null) {
  return familyModelIn('fable', body, contentEncoding, maxBytes, contentType);
}

/** @param {unknown} model */
export function isFableModel(model) {
  return isFamilyModel('fable', model);
}

/**
 * The policy as configured. With no `fable.allow` list, rationing is off and
 * everything passes — the behaviour before this feature. An empty list allows
 * nobody (fail closed).
 * @param {any} config
 */
export function fablePolicy(config) {
  return familyPolicy(config, 'fable');
}

/**
 * @param {{ policy: ReturnType<typeof fablePolicy>, model: unknown, advisorModel?: unknown, client?: string|null, fableAvailable: () => boolean }} a
 * @returns {{ action: 'pass'|'rewrite'|'fallback', to?: string }}
 */
export function decideFable({ policy, model, advisorModel = null, client = null, fableAvailable }) {
  return decideFamily({ policy, model, advisorModel, client, available: fableAvailable });
}

/** @param {Buffer} body @param {string} to @param {string|string[]|undefined|null} [contentEncoding] @param {number} [maxBytes] @param {string|string[]|undefined|null} [contentType] */
export function rewriteFableBody(body, to, contentEncoding = null, maxBytes = DEFAULT_DECODED_MAX, contentType = null) {
  return rewriteFamilyBody('fable', body, to, contentEncoding, maxBytes, contentType);
}

export class FableStats extends FamilyStats {}
