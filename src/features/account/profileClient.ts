import type { Profile } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { File as DeviceFile } from 'expo-file-system';

import { getSupabase } from '@/lib/supabase';

export type ProfileDetails = Pick<Profile, 'display_name' | 'first_name' | 'last_name' | 'phone' | 'avatar_path'>;
export type DetailsPatch = Partial<Pick<Profile, 'display_name' | 'first_name' | 'last_name' | 'phone'>>;

const AVATARS = 'avatars';
// Signed photo links are only for the signed-in user's own screen.
const AVATAR_LINK_SECONDS = 60 * 60;

const text = (value: unknown) => (typeof value === 'string' ? value : null);
/** Tolerates databases without the personal-detail columns yet: missing fields read as empty. */
function details(row: Record<string, unknown>): ProfileDetails {
  return { display_name: text(row.display_name), first_name: text(row.first_name), last_name: text(row.last_name),
    phone: text(row.phone), avatar_path: text(row.avatar_path) };
}

/** undefined means the profile couldn't be read; the screen falls back to the email. RLS returns only the caller's row. */
export async function loadProfile(userId: string): Promise<ProfileDetails | undefined> {
  try {
    const { data, error } = await getSupabase().from('profiles').select('*').eq('id', userId).maybeSingle();
    return error || !data ? undefined : details(data);
  } catch {
    return undefined;
  }
}

/** RLS and column grants limit this to the signed-in user's own name and contact fields. */
export async function saveProfile(userId: string, patch: DetailsPatch): Promise<ProfileDetails> {
  try {
    const { data, error } = await getSupabase().from('profiles').update(patch).eq('id', userId).select('*').single();
    if (error) throw error;
    return details(data);
  } catch {
    throw new Error('We couldn’t save your details. Check your connection and try again.');
  }
}

/** A short-lived link to the user's own private photo, or null if it can't be read. */
export async function avatarUrl(path: string): Promise<string | null> {
  try {
    const { data, error } = await getSupabase().storage.from(AVATARS).createSignedUrl(path, AVATAR_LINK_SECONDS);
    return error ? null : data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * Uploads a new photo under the user's own folder, points the profile at it, then removes the
 * previous one. A failed profile update removes the new upload, so nothing is left behind.
 */
export async function uploadAvatar(userId: string, file: { uri: string; type: 'image/jpeg' | 'image/png' }, previous: string | null): Promise<ProfileDetails> {
  const bucket = getSupabase().storage.from(AVATARS);
  const path = `${userId}/${randomUUID()}.${file.type === 'image/png' ? 'png' : 'jpg'}`;
  try {
    const bytes = await new DeviceFile(file.uri).arrayBuffer();
    const uploaded = await bucket.upload(path, bytes, { contentType: file.type, upsert: false, cacheControl: '3600' });
    if (uploaded.error) throw uploaded.error;
  } catch {
    throw new Error('We couldn’t upload that photo. Check your connection and try again.');
  }
  const { data, error } = await getSupabase().from('profiles').update({ avatar_path: path }).eq('id', userId).select('*').single();
  if (error || !data) {
    await bucket.remove([path]).catch(() => undefined);
    throw new Error('We couldn’t save your photo. Check your connection and try again.');
  }
  if (previous) await bucket.remove([previous]).catch(() => undefined);
  return details(data);
}

/** Clears the profile photo, then deletes the file. */
export async function removeAvatar(userId: string, previous: string | null): Promise<ProfileDetails> {
  const { data, error } = await getSupabase().from('profiles').update({ avatar_path: null }).eq('id', userId).select('*').single();
  if (error || !data) throw new Error('We couldn’t remove your photo. Check your connection and try again.');
  if (previous) await getSupabase().storage.from(AVATARS).remove([previous]).catch(() => undefined);
  return details(data);
}
