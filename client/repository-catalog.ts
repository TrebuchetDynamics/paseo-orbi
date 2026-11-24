import type { DeploymentCatalog } from '../shared/common';
import type { InventoryGroup } from '../shared/services';

// This module owns the repository association: one classification that produces
// both of its sentences, and the presentation-only names a repository catalog
// gives a host's service families. The Services module renders these facts and
// keeps no copy of the branch ladder or of the naming helpers.

export type AssociationClassification = 'matched' | 'matched-unavailable' | 'incompatible' | 'ambiguous' | 'unmatched'
  // A link that the catalog evidence cannot confirm: still unread, or a settled
  // read that failed or was invalid. Never a statement about the deployment.
  | 'pending' | 'unconfirmed';

// The shell's explicit repository-catalog evidence for one service family.
// 'pending' is a read that has not settled; 'unavailable' is a settled read that
// could not confirm anything (failed, invalid or retained after a failure);
// 'confirmed' is a catalog that was actually read.
export type CatalogEvidence = 'pending' | 'unavailable' | 'confirmed';

export type Association = Readonly<{
  classification: AssociationClassification;
  // The short association line that leads the service facts.
  note: string;
  // The full association context, revealed by View diagnostics.
  detail: string;
}>;

type CatalogEntry = DeploymentCatalog['entries'][number];

// A read that has not settled yet is not evidence of absence, failure or an
// authorization problem: both sentences say only that the link is not yet
// confirmed, and no repository action is offered from this classification.
const pendingAssociation: Association = {
  classification: 'pending',
  note: 'Repository link not yet confirmed: this host’s repository catalog has not been read yet.',
  detail: 'Repository link not yet confirmed: this host’s repository catalog has not been read yet, so no repository link is confirmed. Discovery is not authority.',
};
// A settled read that could not confirm anything is named as such instead of
// being turned into an absence claim; discovery is not authority either way.
const unconfirmedAssociation: Association = {
  classification: 'unconfirmed',
  note: 'Repository link not confirmed: this host’s repository catalog could not be read.',
  detail: 'This host’s repository catalog could not be read, so no repository link is confirmed. Discovery is not authority.',
};

// Both sentences come from this one classification, so the short line and the
// diagnostics detail can never disagree. A matched association is described
// from an authorized catalog entry when one exists; without one the catalog, not
// the unit, is named as the missing authority once the read settled. An unlinked
// conclusion is only stated when this host's repository catalog was actually
// read, so a pending, failed or invalid catalog never reads as "not linked";
// discovery alone is not authority either way.
export function associationOf(group: InventoryGroup, entry: CatalogEntry | null, catalog: CatalogEvidence): Association {
  if (group.association === 'matched') {
    if (entry) return {
      classification: 'matched',
      note: `Matches configured deployment ${entry.label} (${entry.repo}) by unit name.`,
      detail: `Matches configured deployment ${entry.label} (${entry.repo}) by unit name. Unit origin is not verified; this association is display-only.`,
    };
    if (catalog === 'pending') return pendingAssociation;
    if (catalog === 'unavailable') return unconfirmedAssociation;
    return {
      classification: 'matched-unavailable',
      note: 'Associated deployment is not in the current authorized catalog.',
      detail: 'Associated deployment is not in the current authorized catalog. Repository detail stays unavailable until the operator restores authorization and reloads.',
    };
  }
  if (group.association === 'incompatible') return {
    classification: 'incompatible',
    note: 'Source profile unsupported for repository detail.',
    detail: 'A configured deployment claims this unit prefix, but its source profile is unsupported for repository detail. This compatibility limit does not mean the runner is broken.',
  };
  if (group.association === 'ambiguous') return {
    classification: 'ambiguous',
    note: 'Multiple configured deployments claim this unit prefix.',
    detail: 'Multiple configured deployments claim this unit prefix. Repository detail stays unavailable until the operator makes the association unique.',
  };
  if (catalog === 'pending') return pendingAssociation;
  if (catalog === 'unavailable') return unconfirmedAssociation;
  return {
    classification: 'unmatched',
    note: 'Not linked to a repository.',
    detail: 'Discovered on this host only; no configured deployment claims this unit name, so repository detail is unavailable. Discovery is not authority.',
  };
}

// These names are presentation only: never use a slug for authorization or navigation.
const shortName = (label: string) => /^orbi-(.+)-[a-f0-9]{8}$/.exec(label)?.[1] ?? label;
export function authorizedEntry(group: InventoryGroup, entries: DeploymentCatalog['entries'] | null): CatalogEntry | null {
  const candidates = entries?.filter(candidate => candidate.id === group.deploymentId) ?? [];
  return group.association === 'matched' && candidates.length === 1 && candidates[0].status === 'available' ? candidates[0] : null;
}
export function displayNames(groups: InventoryGroup[], entries: DeploymentCatalog['entries'] | null) {
  const names = new Map(groups.map(group => {
    const collision = groups.some(other => other.label !== group.label && shortName(other.label) === shortName(group.label));
    return [group.label, authorizedEntry(group, entries)?.repo ?? `${shortName(group.label)}${collision ? ` · ${group.label.slice(-8)}` : ''}`];
  }));
  // Resolve final-name collisions, including raw/short names and collisions
  // introduced by a fallback. Exact labels are unique inventory identities.
  for (;;) {
    const counts = new Map<string, number>();
    for (const name of names.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
    let changed = false;
    for (const [label, name] of names) {
      if (counts.get(name)! > 1 && name !== label) { names.set(label, label); changed = true; }
    }
    if (!changed) return names;
  }
}
