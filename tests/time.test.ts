import { describe, expect, it } from 'vitest';
import { formatLocalTime } from '../client/time';

// One fixed instant, so the expectations describe the formatter and never the
// machine the tests run on: every assertion below pins locale and time zone.
const at = '2026-11-19T18:00:00.000Z';
const chicago = { locale: 'en-US', timeZone: 'America/Chicago' };

describe('formatLocalTime', () => {
  it('renders a timestamp in the viewer zone with date, seconds and zone name', () => {
    const text = formatLocalTime(at, chicago);
    expect(text).toContain('Nov 19, 2026');
    expect(text).toContain('12:00:00');
    expect(text).toContain('PM');
    expect(text).toContain('CST');
  });
  it('renders the same instant differently in another zone', () => {
    expect(formatLocalTime(at, { locale: 'en-US', timeZone: 'UTC' })).toContain('6:00:00 PM');
    expect(formatLocalTime(at, chicago)).not.toContain('6:00:00 PM');
  });
  it('follows daylight saving in the viewer zone', () => {
    const text = formatLocalTime('2026-07-19T18:00:00.000Z', chicago);
    expect(text).toContain('Jul 19, 2026');
    expect(text).toContain('1:00:00 PM');
    expect(text).toContain('CDT');
  });
  it('returns a value that does not parse unchanged', () => {
    expect(formatLocalTime('not-a-date')).toBe('not-a-date');
    expect(formatLocalTime('')).toBe('');
  });
  it('keeps plain spaces around the day period so copied text stays readable', () => {
    expect(formatLocalTime(at, { locale: 'en-US', timeZone: 'UTC' })).not.toMatch(/[\u00a0\u202f]/);
  });
  it('defaults to the runtime locale and time zone', () => {
    expect(formatLocalTime(at)).toBe(new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).format(new Date(at)));
  });
});
