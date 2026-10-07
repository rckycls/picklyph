import { getSupabase } from '@/lib/supabase';

/** undefined means the profile couldn't be read; the screen falls back to the email. */
export async function loadDisplayName(userId: string): Promise<string | null | undefined> {
  try {
    const { data, error } = await getSupabase().from('profiles').select('display_name').eq('id', userId).maybeSingle();
    return error || !data ? undefined : data.display_name;
  } catch {
    return undefined;
  }
}

/** RLS limits this to the signed-in user's own row and only the display_name column. */
export async function saveDisplayName(userId: string, value: string | null): Promise<string | null> {
  try {
    const { data, error } = await getSupabase().from('profiles').update({ display_name: value })
      .eq('id', userId).select('display_name').single();
    if (error) throw error;
    return data.display_name;
  } catch {
    throw new Error('We couldn’t save your name. Check your connection and try again.');
  }
}
