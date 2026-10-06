import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';

const brandFont = localFont({ src: [
  { path: '../../../../node_modules/@expo-google-fonts/bricolage-grotesque/500Medium/BricolageGrotesque_500Medium.ttf', weight: '500', style: 'normal' },
  { path: '../../../../node_modules/@expo-google-fonts/bricolage-grotesque/600SemiBold/BricolageGrotesque_600SemiBold.ttf', weight: '600', style: 'normal' },
  { path: '../../../../node_modules/@expo-google-fonts/bricolage-grotesque/800ExtraBold/BricolageGrotesque_800ExtraBold.ttf', weight: '800', style: 'normal' },
], variable: '--font-brand', display: 'swap' });

export const metadata: Metadata = { title: 'pickly · Console', description: 'PicklyPH administrator and moderator console.', robots: { index: false, follow: false } };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={brandFont.variable}><body><a className="skip-link" href="#main">Skip to content</a>{children}</body></html>;
}
