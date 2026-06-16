// Quria-branded email primitives — the single source of truth for how every
// Aegis HTML email looks. Dark "app" theme (black / brushed silver / orange
// #f97316) to match the Homebase web app (see homebase/src/app/globals.css).
//
// Why this lives in one file: before this, each workflow hand-rolled its own
// light-theme table markup, so branding drifted email to email. Every
// outbound HTML email should now wrap its body in `brandedEmailShell(...)` and
// build its call-to-action buttons with `brandedButton(...)`, so a future
// brand tweak is a one-file change.
//
// Email-client robustness notes:
// - Layout is table + inline-style only (no external CSS, no flexbox).
// - No reliance on box-shadow (Gmail strips it); the orange "glow" is faked
//   with an accent border + accent-dim padding ring, which every client keeps.
// - The logo is referenced by hosted URL (Homebase /public), not a local file
//   or CID attachment, so it renders without attaching anything.

import { getHomebaseUrl } from '../config/urls';
import { QURIA_LOGO_BASE64, QURIA_LOGO_MIME } from './brand-logo';

/** Content-ID the email body references for the inline logo: `cid:quria-logo`. */
export const QURIA_LOGO_CID = 'quria-logo';

/**
 * Structural shape matching messaging/email.ts EmailAttachment. Declared here
 * (not imported) to avoid an import cycle — email.ts imports brand.ts.
 */
export interface BrandInlineAttachment {
  filename: string;
  content: Buffer;
  type: string;
  disposition: 'inline';
  content_id: string;
}

/**
 * The Quria logo as an inline email attachment. `sendEmail` attaches this
 * whenever the rendered HTML references `cid:quria-logo`, so every branded
 * email carries the mark without any external image hosting.
 */
export function quriaLogoInlineAttachment(): BrandInlineAttachment {
  return {
    filename: 'quria-logo.jpg',
    content: Buffer.from(QURIA_LOGO_BASE64, 'base64'),
    type: QURIA_LOGO_MIME,
    disposition: 'inline',
    content_id: QURIA_LOGO_CID,
  };
}

/** Data-URI form of the logo, for browser previews where `cid:` won't resolve. */
export function quriaLogoDataUri(): string {
  return `data:${QURIA_LOGO_MIME};base64,${QURIA_LOGO_BASE64}`;
}

// ── Palette (mirrors homebase globals.css :root tokens) ───────────────────────
export const BRAND = {
  bgBase: '#0d0d0d',
  surface1: '#111111',
  surface2: '#141414',
  surface3: '#1e1e1e',
  borderSubtle: '#1e1e1e',
  borderDefault: '#2a2a2a',
  borderStrong: '#3a3a3a',
  textPrimary: '#e8e8e8',
  textSecondary: '#999999',
  textMuted: '#666666',
  accent: '#f97316',
  accentDark: '#c2582a',
  accentDim: 'rgba(249, 115, 22, 0.12)',
  accentBorder: 'rgba(249, 115, 22, 0.35)',
  silver: '#b0b0b0',
  // Dark-theme status tints (callout boxes)
  goodBg: '#0a2e1a', goodBorder: '#166534', goodText: '#4ade80',
  warnBg: '#2e1a0a', warnBorder: '#7c3a0a', warnText: '#fbbf24', warnRule: '#f59e0b',
  badBg: '#2e0a0a', badBorder: '#7f1d1d', badText: '#f87171',
  reviewBg: '#1a1a2e', reviewBorder: '#3730a3', reviewText: '#818cf8',
} as const;

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The logo lives in the Homebase public folder, so it's served at
 * `${HOMEBASE_URL}/QuriaSolutionsBlack.jpg`. It's a black-background mark, so it
 * sits seamlessly on the black email header with no white box around it.
 * `homebaseUrl` is injectable so previews/tests can pass a URL without env.
 */
export function logoUrl(homebaseUrl?: string): string {
  const base = (homebaseUrl ?? getHomebaseUrl()).replace(/\/+$/, '');
  return `${base}/QuriaSolutionsBlack.jpg`;
}

// ── Buttons ───────────────────────────────────────────────────────────────────

export type BrandButtonVariant = 'primary' | 'secondary';

export interface BrandButton {
  url: string;
  label: string;
  variant?: BrandButtonVariant;
}

/**
 * A single bulletproof-ish action button. `primary` = solid orange (the brand
 * action color); `secondary` = brushed-silver outline (for the cautious/second
 * option, e.g. Deny). Label text is rendered verbatim between the anchor tags
 * (so e.g. tests asserting `>Approve</a>` keep passing).
 */
export function brandedButton(btn: BrandButton): string {
  const variant = btn.variant ?? 'primary';
  const base =
    'display:inline-block;padding:13px 26px;font-size:15px;font-weight:700;' +
    'text-decoration:none;border-radius:8px;line-height:1;';
  const style =
    variant === 'primary'
      ? `${base}background:${BRAND.accent};color:#0d0d0d;border:1px solid ${BRAND.accent};`
      : `${base}background:transparent;color:${BRAND.textPrimary};border:1px solid ${BRAND.borderStrong};`;
  return `<a href="${escapeAttr(btn.url)}" style="${style}">${btn.label}</a>`;
}

/**
 * A row of action buttons with even spacing, table-based so Outlook keeps the
 * gaps. The first button carries an orange "glow" ring (accent-dim padding +
 * accent border) so the primary action reads as lit without needing box-shadow.
 */
export function brandedButtonRow(buttons: BrandButton[]): string {
  const cells = buttons
    .map((b, i) => {
      const glow =
        (b.variant ?? 'primary') === 'primary'
          ? `padding:4px;background:${BRAND.accentDim};border:1px solid ${BRAND.accentBorder};border-radius:11px;`
          : 'padding:4px;border:1px solid transparent;border-radius:11px;';
      return `<td style="padding-right:${i === buttons.length - 1 ? '0' : '10px'};">
        <span style="display:inline-block;${glow}">${brandedButton(b)}</span>
      </td>`;
    })
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr>${cells}</tr></table>`;
}

// ── Reusable section pieces ───────────────────────────────────────────────────

/** Small uppercase brushed-silver label that heads each section. */
export function brandSectionLabel(text: string): string {
  return `<div style="font-size:12px;font-weight:600;color:${BRAND.silver};text-transform:uppercase;letter-spacing:0.08em;margin:0 0 8px;">${text}</div>`;
}

/** A dark surface "card" wrapper for grouped detail. */
export function brandCard(innerHtml: string, accentLeft?: string): string {
  const left = accentLeft ? `border-left:4px solid ${accentLeft};` : '';
  return `<div style="margin:0 0 20px;padding:16px;background:${BRAND.surface2};border:1px solid ${BRAND.borderDefault};${left}border-radius:8px;">${innerHtml}</div>`;
}

/**
 * The "action card": a self-contained, visually distinct panel that holds the
 * actionable request (details + buttons), set apart from the conversational
 * message around it. Darker inset background + a strong border + an orange
 * uppercase label bar, so it reads as its own object — the form Aegis is
 * handing you — not part of Aegis's chat. Reused across every workflow email.
 */
export function brandActionCard(label: string, innerHtml: string): string {
  return `
<div style="margin:26px 0 30px;background:${BRAND.bgBase};border:1px solid ${BRAND.borderStrong};border-radius:12px;overflow:hidden;">
  <div style="background:${BRAND.surface3};border-bottom:1px solid ${BRAND.borderDefault};padding:11px 18px;">
    <span style="font-size:12px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${BRAND.accent};">${label}</span>
  </div>
  <div style="padding:20px 18px 6px;">${innerHtml}</div>
</div>`;
}

// ── The shell ─────────────────────────────────────────────────────────────────

export interface BrandedShellParams {
  /** Inner HTML for the email body (already escaped where needed). */
  bodyHtml: string;
  /** Tenant/club name shown in the footer (optional). */
  companyName?: string;
  /** Inbox-preview text (hidden in the body). */
  preheader?: string;
  /**
   * The logo `<img src>`. Defaults to `cid:quria-logo` (the inline attachment
   * sendEmail adds). Pass a data URI for browser previews, or `null` to render
   * the text wordmark fallback instead of an image.
   */
  logoSrc?: string | null;
}

/**
 * Wraps a body in the full Quria dark email frame: black header with the
 * orchid logo + orange underline, dark card body, and a brushed-silver footer
 * reading "Aegis · Quria Solutions · <club>".
 */
export function brandedEmailShell(params: BrandedShellParams): string {
  const { bodyHtml, companyName, preheader } = params;
  // Default to the inline CID logo (attached by sendEmail). Previews pass a data
  // URI; `null` renders the text wordmark fallback (no image at all).
  const logoSrc = params.logoSrc === undefined ? `cid:${QURIA_LOGO_CID}` : params.logoSrc;
  // Header = the Aegis "A" monogram (the assistant's mark) + a "Quria Solutions"
  // text wordmark. The mark is the inline image; the wordmark is text so it
  // stays crisp and needs no second attachment.
  const markImg = logoSrc
    ? `<img src="${escapeAttr(logoSrc)}" width="56" height="56" alt="Aegis" style="display:block;width:56px;height:56px;border:0;outline:none;text-decoration:none;">`
    : '';
  const wordmark =
    `<span style="font-size:22px;font-weight:700;letter-spacing:0.02em;color:${BRAND.textPrimary};">Aegis</span>`;
  const headerInner = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${
    markImg ? `<td style="vertical-align:middle;padding-right:14px;">${markImg}</td>` : ''
  }<td style="vertical-align:middle;">${wordmark}</td></tr></table>`;
  const footerClub = companyName ? ` · ${escapeAttr(companyName)}` : '';
  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">${escapeAttr(preheader)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
</head>
<body style="margin:0;padding:0;background:${BRAND.bgBase};font-family:${FONT_STACK};color:${BRAND.textPrimary};">
${preheaderHtml}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.bgBase};padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:${BRAND.surface1};border:1px solid ${BRAND.borderDefault};border-radius:12px;overflow:hidden;">
        <tr>
          <td style="background:#000000;padding:18px 28px;border-bottom:2px solid ${BRAND.accent};">
            ${headerInner}
          </td>
        </tr>
        <tr>
          <td style="padding:28px;font-family:${FONT_STACK};font-size:16px;line-height:1.65;color:${BRAND.textPrimary};">
${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="background:${BRAND.bgBase};border-top:1px solid ${BRAND.borderDefault};padding:18px 28px;font-size:12px;color:${BRAND.textMuted};">
            <span style="color:${BRAND.accent};font-weight:700;letter-spacing:0.04em;">Aegis</span> · Quria Solutions${footerClub}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
