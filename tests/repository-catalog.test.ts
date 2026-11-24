import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DeploymentCatalog } from '../shared/common';
import type { InventoryGroup } from '../shared/services';
import { associationOf } from '../client/repository-catalog';

// The repository association is classified once: both user-visible sentences
// belong to that classification. The expected copy below is the copy the
// Services and Service details screens show today (asserted unchanged by
// tests/host-overview.test.tsx); it must never be re-derived from the
// implementation.
const demo: DeploymentCatalog['entries'][number] = {
  id: 'demo', label: 'Demo', repo: 'Example/project', adapter: 'orbi-0.7.41-release',
  status: 'available', problems: [], controls: null,
};
const family = (association: InventoryGroup['association'], deploymentId: string | null = null): InventoryGroup =>
  ({ label: 'orbi-demo', kind: 'runner-family', units: [], association, deploymentId });

const matched = {
  classification: 'matched',
  note: 'Matches configured deployment Demo (Example/project) by unit name.',
  detail: 'Matches configured deployment Demo (Example/project) by unit name. Unit origin is not verified; this association is display-only.',
} as const;
const matchedUnavailable = {
  classification: 'matched-unavailable',
  note: 'Associated deployment is not in the current authorized catalog.',
  detail: 'Associated deployment is not in the current authorized catalog. Repository detail stays unavailable until the operator restores authorization and reloads.',
} as const;
const incompatible = {
  classification: 'incompatible',
  note: 'Source profile unsupported for repository detail.',
  detail: 'A configured deployment claims this unit prefix, but its source profile is unsupported for repository detail. This compatibility limit does not mean the runner is broken.',
} as const;
const ambiguous = {
  classification: 'ambiguous',
  note: 'Multiple configured deployments claim this unit prefix.',
  detail: 'Multiple configured deployments claim this unit prefix. Repository detail stays unavailable until the operator makes the association unique.',
} as const;
const unlinked = {
  classification: 'unmatched',
  note: 'Not linked to a repository.',
  detail: 'Discovered on this host only; no configured deployment claims this unit name, so repository detail is unavailable. Discovery is not authority.',
} as const;
const unconfirmed = {
  classification: 'unconfirmed',
  note: 'Repository link not confirmed: this host’s repository catalog could not be read.',
  detail: 'This host’s repository catalog could not be read, so no repository link is confirmed. Discovery is not authority.',
} as const;
const pending = {
  classification: 'pending',
  note: 'Repository link not yet confirmed: this host’s repository catalog has not been read yet.',
  detail: 'Repository link not yet confirmed: this host’s repository catalog has not been read yet, so no repository link is confirmed. Discovery is not authority.',
} as const;
const evidence = ['pending', 'unavailable', 'confirmed'] as const;

describe('one classification returns both association sentences', () => {
  it('classifies a matched association through its authorized catalog entry', () => {
    // Positive evidence wins over the catalog read state: the entry, not the
    // read, decides this copy and keeps the existing match sentence.
    for (const catalog of evidence) expect(associationOf(family('matched', 'demo'), demo, catalog)).toEqual(matched);
  });
  it('classifies a matched association whose deployment is not authorized only when the read settled', () => {
    expect(associationOf(family('matched', 'demo'), null, 'confirmed')).toEqual(matchedUnavailable);
    // A settled read that confirmed nothing is unavailable, never an absence claim.
    expect(associationOf(family('matched', 'demo'), null, 'unavailable')).toEqual(unconfirmed);
    expect(associationOf(family('matched', 'demo'), null, 'pending')).toEqual(pending);
  });
  it('classifies an incompatible association', () => {
    // A stray entry or an unreadable catalog cannot change this sentence.
    for (const catalog of evidence) for (const entry of [null, demo]) {
      expect(associationOf(family('incompatible'), entry, catalog)).toEqual(incompatible);
    }
  });
  it('classifies an ambiguous association', () => {
    for (const catalog of evidence) for (const entry of [null, demo]) {
      expect(associationOf(family('ambiguous'), entry, catalog)).toEqual(ambiguous);
    }
  });
  it('classifies an unmatched association by the catalog evidence', () => {
    for (const entry of [null, demo]) {
      expect(associationOf(family('unmatched'), entry, 'confirmed')).toEqual(unlinked);
      expect(associationOf(family('unmatched'), entry, 'unavailable')).toEqual(unconfirmed);
      expect(associationOf(family('unmatched'), entry, 'pending')).toEqual(pending);
    }
  });
  it('never states failure, absence or authorization trouble while the catalog is pending', () => {
    // Acceptance for #113: an in-flight catalog is not evidence about the link.
    for (const group of [family('matched', 'demo'), family('unmatched')]) {
      const association = associationOf(group, null, 'pending');
      expect(association).toEqual(pending);
      for (const sentence of [association.note, association.detail]) {
        expect(sentence).toContain('Repository link not yet confirmed');
        expect(sentence).not.toMatch(/failed|could not be read|not in the current authorized|unauthoriz|restore/i);
      }
    }
  });
});

// The Services module renders this classification and the catalog naming; it
// owns neither. One ladder and one owner are a static property of the source.
const read = (path: string) => readFileSync(path, 'utf8');
const occurrences = (source: string, needle: string) => source.split(needle).length - 1;

describe('the repository association has one owner', () => {
  const overview = read('client/host-overview.tsx');
  const owner = read('client/repository-catalog.ts');

  it('keeps exactly one reference to group.association in the Services module, as the observed-deployment filter', () => {
    expect(occurrences(overview, 'group.association')).toBe(1);
    const [reference] = overview.split('\n').filter(line => line.includes('group.association'));
    expect(reference).toContain("group.association === 'matched'");
    expect(overview).toContain('observedDeploymentIds');
  });
  it('keeps no local copy of the naming helpers or of the association copy', () => {
    for (const helper of ['shortName', 'authorizedEntry', 'displayNames']) {
      expect(overview, `client/host-overview.tsx: no local ${helper}`).not.toMatch(new RegExp(`(?:function|const)\\s+${helper}\\b`));
      expect(owner, `client/repository-catalog.ts: owns ${helper}`).toMatch(new RegExp(`(?:function|const)\\s+${helper}\\b`));
    }
    for (const helper of ['associationOf', 'authorizedEntry', 'displayNames']) {
      expect(overview, `client/host-overview.tsx: imports ${helper}`).toMatch(new RegExp(`import \\{[^}]*\\b${helper}\\b`));
    }
    expect(overview).toContain("from './repository-catalog'");
    // Both sentences and the branch ladder live only in the owner.
    expect(overview).not.toContain('associationText');
    expect(overview).not.toContain('associationNote');
    for (const sentence of ['Matches configured deployment', 'Not linked to a repository.', 'Repository link not confirmed']) {
      expect(overview, `client/host-overview.tsx: no association copy`).not.toContain(sentence);
      expect(owner, `client/repository-catalog.ts: owns the association copy`).toContain(sentence);
    }
  });
});
