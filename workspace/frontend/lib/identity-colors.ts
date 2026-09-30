export const IDENTITY_COLOR_NAMES = [
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "rose",
  "amber",
  "cyan",
  "blue",
  "fuchsia",
  "lime",
  "purple",
  "coral",
  "slate",
] as const;

export type IdentityColorName = (typeof IDENTITY_COLOR_NAMES)[number];

const IDENTITY_COLORS: Record<IdentityColorName, string> = {
  violet: "#8b76c8",
  sky: "#4f8ebc",
  emerald: "#4e9b63",
  orange: "#b87f47",
  pink: "#ba6679",
  indigo: "#6d78b8",
  teal: "#439693",
  rose: "#b5596e",
  amber: "#a3893c",
  cyan: "#3792a4",
  blue: "#577fb5",
  fuchsia: "#9c5fad",
  lime: "#5f9435",
  purple: "#7d5fb0",
  coral: "#b86352",
  slate: "#65768d",
};

export function identityColor(name: IdentityColorName): string {
  return IDENTITY_COLORS[name] || IDENTITY_COLORS.violet;
}

export function identityTint(name: IdentityColorName): string {
  return `${identityColor(name)}1a`;
}

function hashIdentityKey(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function deriveIdentityColorName(key: string): IdentityColorName {
  const normalized = (key || 'agent').trim().toLowerCase();
  const index = hashIdentityKey(normalized) % IDENTITY_COLOR_NAMES.length;
  return IDENTITY_COLOR_NAMES[index];
}

export function deriveIdentityColor(key: string): string {
  return identityColor(deriveIdentityColorName(key));
}
