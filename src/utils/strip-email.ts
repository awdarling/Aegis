// Markers that begin a quoted reply block. Anything from this line onward is
// the prior thread, not the sender's new content.
const REPLY_MARKERS: RegExp[] = [
  /^on .+ wrote:?\s*$/i,
  /^-{3,}\s*original message\s*-{3,}/i,
  /^_{3,}/,
  /^from:\s+/i,
];

export function stripEmailBody(text: string): string {
  const lines = text.split(/\r?\n/);

  let replyCutoff = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (REPLY_MARKERS.some((re) => re.test(lines[i]))) {
      replyCutoff = i;
      break;
    }
  }

  const beforeQuote = lines.slice(0, replyCutoff);
  const withoutQuoted = beforeQuote.filter((line) => !/^\s*>/.test(line));

  // RFC 3676 signature delimiter is "-- " on its own line; many clients drop
  // the trailing space, so match either form.
  let sigCutoff = withoutQuoted.length;
  for (let i = 0; i < withoutQuoted.length; i++) {
    if (/^--\s*$/.test(withoutQuoted[i])) {
      sigCutoff = i;
      break;
    }
  }

  return withoutQuoted.slice(0, sigCutoff).join('\n').trim();
}

export function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}
