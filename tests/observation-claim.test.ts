import './helpers/host';
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { claimOf, type Claim, type Reach } from '../client/observation';
import type { Observation } from '../shared/common';

const stamp = '2026-11-19T18:00:00.000Z';
// A hand-built envelope: the state table below owns which combination is expected,
// and the screens are asserted separately by their unchanged suites.
const reading = (state: Observation<unknown>['state'] | null, payload: string | null, lastSuccessfulAt: string | null = stamp): Observation<unknown> | undefined =>
  state === null ? undefined : { state, observedAt: stamp, lastSuccessfulAt, data: payload === null ? null : { state: payload }, problems: [] };
const reach: Reach = { connected: true, foreground: true };
const unreachable: Reach = { connected: false, foreground: false };
const background: Reach = { connected: true, foreground: false };
const facts = (expected: Pick<Claim, 'state' | 'payload' | 'reach' | 'stale' | 'reading' | 'count' | 'absence'>) => expected;

describe('one reading claim for every screen', () => {
  it('decides the facts and the permissions once, for every envelope, payload and reach', () => {
    const rows: Array<[name: string, observation: Observation<unknown> | undefined, at: Reach,
      expected: Pick<Claim, 'state' | 'payload' | 'reach' | 'stale' | 'reading' | 'count' | 'absence'>]> = [
      ['no reach and no envelope claims nothing and reads nothing',
        reading(null, null), unreachable, facts({ state: 'unavailable', payload: null, reach: false, stale: false, reading: false, count: false, absence: false })],
      ['background without reach claims nothing and reads nothing',
        reading(null, null), background, facts({ state: 'unavailable', payload: null, reach: false, stale: false, reading: false, count: false, absence: false })],
      ['no envelope with reach is one read in progress',
        reading(null, null), reach, facts({ state: 'loading', payload: null, reach: true, stale: false, reading: true, count: false, absence: false })],
      ['current complete evidence may publish a count and an absence claim',
        reading('available', 'complete'), reach, facts({ state: 'complete', payload: 'complete', reach: true, stale: false, reading: false, count: true, absence: true })],
      ['current partial evidence may publish a count but never an absence claim',
        reading('available', 'partial'), reach, facts({ state: 'partial', payload: 'partial', reach: true, stale: false, reading: false, count: true, absence: false })],
      ['a partial envelope keeps the payload partial word countable',
        reading('partial', 'partial'), reach, facts({ state: 'partial', payload: 'partial', reach: true, stale: false, reading: false, count: true, absence: false })],
      ['an off answer is its own word and publishes nothing',
        reading('available', 'off', null), reach, facts({ state: 'off', payload: 'off', reach: true, stale: false, reading: false, count: false, absence: false })],
      ['a denied or failed payload stays unavailable and publishes nothing',
        reading('available', 'unavailable', null), reach, facts({ state: 'unavailable', payload: 'unavailable', reach: true, stale: false, reading: false, count: false, absence: false })],
      ['an unavailable envelope with no payload settles unavailable',
        reading('unavailable', null, null), reach, facts({ state: 'unavailable', payload: null, reach: true, stale: false, reading: false, count: false, absence: false })],
      ['retained rows make the word stale and publish nothing',
        reading('stale', 'complete'), reach, facts({ state: 'stale', payload: 'complete', reach: true, stale: true, reading: false, count: false, absence: false })],
      ['a stale envelope without a retained success keeps the payload word',
        reading('stale', 'complete', null), reach, facts({ state: 'complete', payload: 'complete', reach: true, stale: false, reading: false, count: false, absence: false })],
      ['a stale answer over off keeps the off word (#108)',
        reading('stale', 'off', null), reach, facts({ state: 'off', payload: 'off', reach: true, stale: false, reading: false, count: false, absence: false })],
      ['a stale answer over unavailable keeps the unavailable word (#108)',
        reading('stale', 'unavailable', null), reach, facts({ state: 'unavailable', payload: 'unavailable', reach: true, stale: false, reading: false, count: false, absence: false })],
      ['a disconnected reading keeps its word and publishes nothing',
        reading('available', 'complete'), unreachable, facts({ state: 'complete', payload: 'complete', reach: false, stale: false, reading: false, count: false, absence: false })],
      ['retained rows outrank a disconnect and still publish nothing',
        reading('stale', 'partial'), unreachable, facts({ state: 'stale', payload: 'partial', reach: false, stale: true, reading: false, count: false, absence: false })],
      ['a catalog payload has no reading word, so the envelope word stands',
        reading('available', 'configured'), reach, facts({ state: 'available', payload: null, reach: true, stale: false, reading: false, count: false, absence: false })],
      ['a page payload has no reading word, so the envelope word stands',
        reading('available', 'open'), reach, facts({ state: 'available', payload: null, reach: true, stale: false, reading: false, count: false, absence: false })],
    ];
    for (const [name, observation, at, expected] of rows) {
      const claim = claimOf(observation, at);
      expect({ ...claim }, name).toEqual({
        envelope: observation?.state ?? null, ...expected,
      });
    }
  });

  it('reads the payload word only from the closed reading vocabulary', () => {
    expect(claimOf({ state: 'available', observedAt: stamp, lastSuccessfulAt: stamp, data: { state: 'unavailable' }, problems: [] }, reach)).toMatchObject({ payload: 'unavailable' });
    expect(claimOf({ state: 'available', observedAt: stamp, lastSuccessfulAt: stamp, data: { state: 'invalid' }, problems: [] }, reach)).toMatchObject({ payload: null, state: 'available' });
  });
});

// Static contract: the six derivations are gone, so no other client module may
// hold the evidence predicate or word a screen from the raw envelope.
const source = (file: string) => readFileSync(file, 'utf8');
const clientModules = () => readdirSync('client', { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => `client/${entry.name}`).sort();
// The predicate is the one expression that pairs both reading words. A screen's
// own word mapping ('complete' shown as 'Current') is not this predicate.
const hasEvidencePredicate = (text: string) => /'complete'[^;\n]{0,40}'partial'|'partial'[^;\n]{0,40}'complete'/.test(text);

describe('the claim is decided in one client module', () => {
  it('keeps the complete/partial evidence predicate in exactly one client module', () => {
    const owners = clientModules().filter(file => hasEvidencePredicate(source(file)));
    expect(owners).toEqual(['client/observation.tsx']);
  });
  it('imports the claim instead of wording any screen from the raw envelope state', () => {
    for (const file of ['client/shell.tsx', 'client/work.tsx', 'client/host-overview.tsx']) {
      const text = source(file);
      expect(text, `${file}: imports claimOf`).toMatch(/import \{[^}]*\bclaimOf\b[^}]*\} from '\.\/observation';/);
      expect(text, `${file}: no raw envelope wording`).not.toMatch(/observation[!?]?\.state/);
    }
  });
});
