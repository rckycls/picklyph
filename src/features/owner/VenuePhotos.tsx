import { MAX_VENUE_PHOTOS, type OwnerPhotoAdd, type OwnerVenuePhoto } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors } from '@/theme/colors';

import { venuePhotoUrl } from '@/lib/venuePhotos';

import { liveAddVenuePhoto, liveRemoveVenuePhoto } from './liveOwner';
import { venueFailureMessage, type PhotoFile } from './venueClient';
import { photoProblem } from './venueDraft';

type Pending = { request: OwnerPhotoAdd; file: PhotoFile };

/**
 * Public venue photos. Each upload or removal is its own server command, separate from Save,
 * and only the photo list is taken from the reply so unsaved detail edits keep their version.
 */
export function VenuePhotos({ venueId, photos, onChange, disabled }: {
  venueId: string; photos: readonly OwnerVenuePhoto[]; onChange: (photos: OwnerVenuePhoto[]) => void; disabled?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // A failed upload keeps its request ID, so "Try again" cannot add the same photo twice.
  const pending = useRef<Pending | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const full = photos.length >= MAX_VENUE_PHOTOS;

  const upload = async (next: Pending) => {
    pending.current = next;
    setBusy('add'); setMessage(null); setCanRetry(false);
    const outcome = await liveAddVenuePhoto(next.request, next.file);
    setBusy(null);
    if (outcome.ok) {
      pending.current = null;
      onChange(outcome.value.photos);
      setMessage('Photo added. Players can see it now.');
      return;
    }
    setMessage(venueFailureMessage(outcome.failure));
    const retryable = outcome.failure.kind === 'network' || outcome.failure.kind === 'unavailable' || outcome.failure.kind === 'rate_limited';
    if (!retryable) pending.current = null;
    setCanRetry(retryable);
  };

  const pick = async () => {
    setMessage(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], allowsMultipleSelection: false, allowsEditing: false, quality: 0.85, exif: false, base64: false,
        // HEIC library photos are delivered as JPEG.
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset) return;
      const checked = photoProblem(asset);
      if ('problem' in checked) { setMessage(checked.problem); setCanRetry(false); return; }
      await upload({ request: { venue_id: venueId, request_id: randomUUID() },
        file: { uri: asset.uri, name: checked.type === 'image/png' ? 'photo.png' : 'photo.jpg', type: checked.type, size: asset.fileSize ?? null } });
    } catch {
      setBusy(null);
      setMessage('Couldn’t open your photos. Try again.');
    }
  };

  const remove = (photo: OwnerVenuePhoto, index: number) => {
    Alert.alert('Remove this photo?', 'Players will no longer see it on your listing.', [
      { text: 'Keep photo', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => {
        setBusy(photo.id); setMessage(null); setCanRetry(false);
        void liveRemoveVenuePhoto(venueId, photo.id).then((outcome) => {
          setBusy(null);
          if (outcome.ok) { onChange(outcome.value.photos); setMessage(`Photo ${index + 1} removed.`); }
          else setMessage(venueFailureMessage(outcome.failure));
        });
      } },
    ]);
  };

  return (
    <View style={styles.group}>
      <Text accessibilityRole="header" style={screenText.title}>Photos</Text>
      <Text style={screenText.body}>
        Show players your courts. Photos are public on your listing; pickly removes location, camera and date details from every photo before it’s shown.
      </Text>
      <StatusBadge label={`${photos.length} of ${MAX_VENUE_PHOTOS} photos`} tone="neutral" />
      <View style={styles.grid}>
        {photos.map((photo, index) => (
          <View key={photo.id} style={styles.tile}>
            <Image source={{ uri: venuePhotoUrl(photo.storage_path) }} style={styles.image} resizeMode="cover"
              accessible accessibilityLabel={`Venue photo ${index + 1} of ${photos.length}`} />
            <Button label={busy === photo.id ? 'Removing…' : 'Remove'} variant="secondary" style={styles.remove}
              accessibilityLabel={`Remove photo ${index + 1}`} disabled={disabled || busy !== null} loading={busy === photo.id}
              onPress={() => remove(photo, index)} />
          </View>
        ))}
      </View>
      {busy === 'add' && (
        <View style={styles.row} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.primary} accessible={false} />
          <Text style={screenText.body}>Uploading your photo…</Text>
        </View>
      )}
      {message && <Text accessibilityLiveRegion="polite" style={screenText.body}>{message}</Text>}
      {canRetry && (
        <Button label="Try again" variant="secondary" disabled={busy !== null} onPress={() => { if (pending.current) void upload(pending.current); }} />
      )}
      <Button label={full ? 'Photo limit reached' : 'Add a photo'} disabled={disabled || full || busy !== null} onPress={() => void pick()}
        accessibilityHint={full ? `Remove a photo to add another. Up to ${MAX_VENUE_PHOTOS} photos.` : 'JPEG or PNG, up to 5 MB.'} />
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { flexBasis: '47%', flexGrow: 1, gap: 6 },
  image: { width: '100%', aspectRatio: 4 / 3, borderRadius: 14, backgroundColor: colors.selectedBackground },
  remove: { minHeight: 40 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
