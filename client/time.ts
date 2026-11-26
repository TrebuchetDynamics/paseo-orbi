// Every timestamp the plugin shows an operator is rendered in the viewer's own
// locale and time zone: the RPC payloads, schemas, cached data and staleness
// arithmetic keep ISO strings, only the display changes. Seconds stay because
// operators compare these times with logs and GitHub events, and the short zone
// name keeps a copied time unambiguous. A value that does not parse is returned
// unchanged, so a bad timestamp is never hidden or turned into a wrong time.
const format = (options?: { locale?: string; timeZone?: string }) => new Intl.DateTimeFormat(options?.locale, {
  year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  timeZone: options?.timeZone,
});

export function formatLocalTime(iso: string, options?: { locale?: string; timeZone?: string }): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  // Some ICU builds separate the day period with a narrow no-break space; a
  // plain space keeps the text readable when an operator copies it into a report.
  return format(options).format(date).replace(/[\u00a0\u202f]/g, ' ');
}
