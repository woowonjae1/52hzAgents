export const IDENTITY_COLOR_NAMES = [
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
] as const;

export type IdentityColorName = (typeof IDENTITY_COLOR_NAMES)[number];

/**
 * Agent identity hues, calibrated for the neutral `#212121` ground.
 *
 * These carry information — "which agent said this" — so unlike decoration they
 * survive the no-brand-accent rule, the same way an error red or a link blue
 * does. They only ever appear as a 6px dot or a 2px rail, so the constraint is
 * that ten of them stay tellable apart at a few pixels wide while none of them
 * out-shouts the text.
 *
 * The whole ramp sits in one band — L 52-66%, S 25-39% — so no single agent
 * reads as more important than another. Four are the anchors from the design
 * proposal (violet / sky / emerald / pink); the other six are placed at even
 * hue intervals inside the same band. The previous set sat 10-15% darker and
 * went muddy against this ground once it stopped being near-black.
 *
 * Change all ten together or not at all: nudging one hue to taste is what makes
 * a ramp drift into "some are brighter than others".
 */
const IDENTITY_COLORS: Record<IdentityColorName, string> = {
  violet: "#9b8bc4", // hsl(257 33% 66%) — anchor
  sky: "#6d9bbf", // hsl(206 39% 59%) — anchor
  emerald: "#6fa97f", // hsl(137 25% 55%) — anchor
  orange: "#bc9976", // hsl( 30 34% 60%)
  pink: "#c0808f", // hsl(346 34% 63%) — anchor
  indigo: "#858dc2", // hsl(232 33% 64%)
  teal: "#62a7a5", // hsl(178 28% 52%)
  red: "#c1857b", // hsl(  8 36% 62%)
  amber: "#b19f68", // hsl( 45 32% 55%)
  blue: "#7b98c1", // hsl(215 36% 62%)
};

export function identityColor(name: IdentityColorName): string {
  return IDENTITY_COLORS[name] || IDENTITY_COLORS.violet;
}

export function identityTint(name: IdentityColorName): string {
  return `${identityColor(name)}1a`;
}

function hashIdentityKey(key: string): number {
  let hash = 0;
  for (const character of key) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function deriveIdentityColorName(key: string): IdentityColorName {
  const index = hashIdentityKey(key) % IDENTITY_COLOR_NAMES.length;
  return IDENTITY_COLOR_NAMES[index];
}

export function deriveIdentityColor(key: string): string {
  return identityColor(deriveIdentityColorName(key));
}
