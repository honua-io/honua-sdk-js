/**
 * Operator theming tokens. Flat name-keyed map matching the
 * `HonuaMapPackageThemeSpec` shape from `src/runtime/map-package.ts` so
 * one theme can drive both the map runtime and the surrounding operator
 * components.
 *
 * @module
 */

/**
 * Canonical token identifiers used by the reference Web Components. New
 * surfaces add token ids here; reference components MUST reference these
 * names rather than ad-hoc strings.
 */
export const OPERATOR_TOKEN_IDS = [
  "color.surface",
  "color.surface-muted",
  "color.surface-elevated",
  "color.text",
  "color.text-muted",
  "color.accent",
  "color.danger",
  "color.warning",
  "color.success",
  "color.border",
  "space.xs",
  "space.sm",
  "space.md",
  "space.lg",
  "radius.sm",
  "radius.md",
  "font.body",
  "font.mono",
] as const;

export type OperatorTokenId = (typeof OPERATOR_TOKEN_IDS)[number];

export type OperatorThemeTokens = Partial<Record<OperatorTokenId, string | number>>;

/**
 * Neutral defaults used by reference components when the embedder has
 * not supplied a theme.
 */
export const DEFAULT_OPERATOR_TOKENS: Readonly<Record<OperatorTokenId, string>> = {
  "color.surface": "#ffffff",
  "color.surface-muted": "#f5f5f7",
  "color.surface-elevated": "#ffffff",
  "color.text": "#1a1a1a",
  "color.text-muted": "#5a5a5a",
  "color.accent": "#1f6feb",
  "color.danger": "#cf222e",
  "color.warning": "#9a6700",
  "color.success": "#1a7f37",
  "color.border": "#d0d7de",
  "space.xs": "4px",
  "space.sm": "8px",
  "space.md": "16px",
  "space.lg": "24px",
  "radius.sm": "4px",
  "radius.md": "8px",
  "font.body": "system-ui, -apple-system, Segoe UI, sans-serif",
  "font.mono": "ui-monospace, SFMono-Regular, monospace",
};

/**
 * Convert a token id like `color.accent` to its CSS custom property name
 * `--operator-color-accent`. Lower-case, dot replaced with hyphen, no
 * other transforms.
 */
export function tokenIdToCssVariable(id: string): string {
  return `--operator-${id.replace(/\./g, "-")}`;
}
