import { useLocalSearchParams } from 'expo-router';

import { ReportListing } from '@/features/discovery/ReportListing';

export default function ReportRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ReportListing id={id} />;
}
