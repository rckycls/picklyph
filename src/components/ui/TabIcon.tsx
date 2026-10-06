import { Image, StyleSheet, View, type ColorValue } from 'react-native';

type IconName = 'discover' | 'bookings' | 'account';

/** Small line icons drawn with native views, with no font-loading dependency. */
export function TabIcon({ name, color }: { name: IconName; color: ColorValue }) {
  return (
    <View style={styles.box} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {name === 'discover' && (
        <Image source={require('../../../assets/brand/mark-small.png')} style={[styles.pin, { tintColor: color }]} resizeMode="contain" accessible={false} />
      )}
      {name === 'bookings' && (
        <View style={[styles.calendar, { borderColor: color }]}>
          <View style={[styles.calendarLine, { backgroundColor: color }]} />
          <View style={[styles.date, { backgroundColor: color }]} />
        </View>
      )}
      {name === 'account' && (
        <>
          <View style={[styles.head, { borderColor: color }]} />
          <View style={[styles.shoulders, { borderColor: color }]} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  pin: { width: 18, height: 26 },
  calendar: { width: 22, height: 22, borderWidth: 2, borderRadius: 5 },
  calendarLine: { position: 'absolute', top: 5, left: 0, right: 0, height: 2 },
  date: { position: 'absolute', width: 4, height: 4, top: 11, left: 5, borderRadius: 1 },
  head: { position: 'absolute', top: 1, width: 10, height: 10, borderWidth: 2, borderRadius: 5 },
  shoulders: { position: 'absolute', bottom: 1, width: 22, height: 11, borderWidth: 2, borderTopLeftRadius: 12, borderTopRightRadius: 12, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 },
});
