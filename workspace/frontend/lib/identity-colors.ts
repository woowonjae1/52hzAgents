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

const IDENTITY_COLORS: Record<IdentityColorName, string> = {
  violet: "#7a6aa8",
  sky: "#3d7ea6",
  emerald: "#388068",
  orange: "#a4673a",
  pink: "#b05c80",
  indigo: "#6a70b8",
  teal: "#368080",
  red: "#b06260",
  amber: "#8f7838",
  blue: "#5179b0",
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
