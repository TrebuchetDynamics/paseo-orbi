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
  { id: 'overview-compact-expanded-slots-light-375x667', scenario: 'available', state: 'complete', theme: 'light', viewport: hostFirstViewports[0], supplemental: true, expanded: 'orbi-demo' },
  { id: 'overview-unconfigured-light-1920x1080', scenario: 'unconfigured', state: 'unconfigured', theme: 'light', viewport: hostFirstViewports[2], supplemental: true },
  { id: 'overview-partial-dark-375x667', scenario: 'denied', state: 'partial', theme: 'dark', viewport: hostFirstViewports[0], supplemental: true },
  { id: 'overview-long-family-light-375x667', scenario: 'available', state: 'complete', theme: 'light', viewport: hostFirstViewports[0], supplemental: true, expanded: 'orbi-analytics-pipeline-with-a-very-long-family-name' },
];
export const hostFirstTitles = [
  'overview: failed timer beside running service and starting/active-exited are distinguishable without color',
  'overview: unique repository drill-down and keyboard-only expand, technical detail and return',
  'overview: no configured repository keeps discovered families unlinked and refuses detail',
  'overview: inventory off keeps the authorized repository reachable',
  'overview: unsupported source profile refuses repository detail without calling the runner broken',
  'overview: partial denied read stays visible and is never published as empty',
  'overview: same-label host switch shows the selected host without stale carryover',
  'overview: late host-switch response is discarded and offline states never publish absence',
  'capture: host Overview evidence (six matrix images and four additional states)',
];
export const hostFirstCaptureTitle = hostFirstTitles[hostFirstTitles.length - 1];
