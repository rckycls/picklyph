// Types for environment.cjs, so app.config.ts can import it under strict TypeScript.

export type AppVariant = 'development' | 'preview' | 'production';

export interface ReleaseEnvironments {
  backends: Record<string, { projectRef: string | null }>;
  variants: Record<string, string>;
  iosBundleIdentifier?: string;
}

export interface Backend {
  name: string;
  ref: string | null;
  others: { name: string; ref: string }[];
}

export const VARIANTS: AppVariant[];
export const REQUIRED_SECRETS: string[];
export const ENVIRONMENT_SECRETS: string[];
export const SERVER_SETTING_NAMES: string[];

export function sha256(text: string): string;
export function projectRefFromUrl(url: string | undefined): string | null;
export function jwtPayload(token: string | undefined): Record<string, unknown> | null;
export function hasSupabaseSecretKey(text: string | undefined): boolean;
export function secretKind(value: string | undefined): string | null;
export function backendFor(environments: ReleaseEnvironments, variant: string): Backend | null;
export function checkMobileEnvironment(input: {
  variant: string;
  env: Record<string, string | undefined>;
  environments: ReleaseEnvironments;
}): { backend: Backend | null; problems: string[] };
export function scanBundle(input: {
  variant: string;
  files: { name: string; text: string }[];
  environments: ReleaseEnvironments;
}): string[];
export function parseSecretsList(text: string): Map<string, string>;
export function checkFunctionSecrets(input: {
  backendName: string;
  secrets: Map<string, string>;
  environments: ReleaseEnvironments;
  other?: Map<string, string>;
  otherName?: string;
}): string[];
export function checkLinkedProject(input: {
  variant: string;
  linkedRef: string | null;
  environments: ReleaseEnvironments;
}): string[];
