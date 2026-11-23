import type { DeploymentCatalog } from '../shared/common';
import type { InventoryGroup } from '../shared/services';

// This module owns the repository association: one classification that produces
// both of its sentences, and the presentation-only names a repository catalog
// gives a host's service families. The Services module renders these facts and
// keeps no copy of the branch ladder or of the naming helpers.

export type AssociationClassification = 'matched' | 'matched-unavailable' | 'incompatible' | 'ambiguous' | 'unmatched';

export type Association = Readonly<{
  classification: AssociationClassification;
  // The short association line that leads the service facts.
  note: string;
  // The full association context, revealed by View diagnostics.
  detail: string;
}>;

type CatalogEntry = DeploymentCatalog['entries'][number];

// Both sentences come from this one classification, so the short line and the
// diagnostics detail can never disagree. A matched association is described
// from an authorized catalog entry when one exists; without one the catalog, not
// the unit, is named as the missing authority. An unlinked conclusion is only
// stated when this host's repository catalog was actually read, so a failed,
// invalid or still-loading catalog never reads as "not linked"; discovery alone
// is not authority either way.
export function associationOf(group: InventoryGroup, entry: CatalogEntry | null, catalogConfirmed: boolean): Association {
  if (group.association === 'matched') {
    return entry
      ? {
        classification: 'matched',
        note: `Matches configured deployment ${entry.label} (${entry.repo}) by unit name.`,
        detail: `Matches configured deployment ${entry.label} (${entry.repo}) by unit name. Unit origin is not verified; this association is display-only.`,
      }
      : {
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
  return catalogConfirmed
    ? {
      classification: 'unmatched',
      note: 'Not linked to a repository.',
      detail: 'Discovered on this host only; no configured deployment claims this unit name, so repository detail is unavailable. Discovery is not authority.',
    }
    : {
      classification: 'unmatched',
      note: 'Repository link not confirmed: this host’s repository catalog could not be read.',
      detail: 'This host’s repository catalog could not be read, so no repository link is confirmed. Discovery is not authority.',
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
