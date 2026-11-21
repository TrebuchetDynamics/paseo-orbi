// Shared host-first contract between the opt-in Playwright suite and its
// separate validator. Titles and image cases are declared once so evidence
// cannot silently shrink.
export const hostFirstViewports = [
  { width: 375, height: 667 },
  { width: 768, height: 1024 },
  { width: 1920, height: 1080 },
];
export const hostFirstThemes = ['light', 'dark'];
export const hostFirstScreenshots = [
  ...hostFirstThemes.flatMap(theme => hostFirstViewports.map(viewport => ({
    id: `overview-available-${theme}-${viewport.width}x${viewport.height}`,
    scenario: 'available', state: 'complete', theme, viewport,
  }))),
  { id: 'overview-compact-details-light-375x667', scenario: 'available', state: 'complete', theme: 'light', viewport: hostFirstViewports[0], supplemental: true, details: 'Example/project' },
  { id: 'overview-unconfigured-light-1920x1080', scenario: 'unconfigured', state: 'unconfigured', theme: 'light', viewport: hostFirstViewports[2], supplemental: true },
  { id: 'overview-partial-dark-375x667', scenario: 'denied', state: 'partial', theme: 'dark', viewport: hostFirstViewports[0], supplemental: true },
  { id: 'overview-long-family-light-375x667', scenario: 'available', state: 'complete', theme: 'light', viewport: hostFirstViewports[0], supplemental: true, details: 'orbi-analytics-pipeline-with-a-very-long-family-name' },
];
export const hostFirstTitles = [
  'services: failed timer beside running service and starting/active-exited are distinguishable without color',
  'services: unique repository drill-down and keyboard-only diagnostics with Back',
  'services: no configured repository keeps discovered families unlinked and refuses detail',
  'services: inventory off keeps the authorized repository reachable',
  'services: unsupported source profile refuses repository detail without calling the runner broken',
  'services: partial denied read stays visible and is never published as empty',
  'services: same-label host switch shows the selected host without stale carryover',
  'services: late host-switch response is discarded and offline states never publish absence',
  'work: configured landing shows issue titles and label chips while unconfigured lands on Services',
  'capture: Services evidence (six matrix images and four additional states)',
];
export const hostFirstCaptureTitle = hostFirstTitles[hostFirstTitles.length - 1];
