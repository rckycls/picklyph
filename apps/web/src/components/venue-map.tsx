'use client';

import { useEffect, useRef, useState } from 'react';

// Google Maps JavaScript API with a fixed pin in the middle: owners drag (or tap) the map until the pin sits on
// their courts. Only the parts of the Maps API used here are typed. The browser key needs only this API.
export type LatLng = { lat: number; lng: number };
type MapsLatLng = { lat(): number; lng(): number };
type Listener = { remove(): void };
type MapInstance = {
  getCenter(): MapsLatLng | undefined;
  getZoom(): number | undefined;
  setCenter(point: LatLng): void;
  setZoom(zoom: number): void;
  panTo(point: LatLng): void;
  addListener(name: string, handler: (event: { latLng?: MapsLatLng }) => void): Listener;
};
type GoogleMaps = { maps: { importLibrary(name: 'maps'): Promise<{ Map: new (element: HTMLElement, options: Record<string, unknown>) => MapInstance }> } };
type MapsWindow = Window & { google?: GoogleMaps; __picklyMapsReady?: () => void; gm_authFailure?: () => void };

const PHILIPPINES = { lat: 12.3, lng: 122.6 };
let loading: Promise<GoogleMaps> | null = null;

function loadMaps(key: string): Promise<GoogleMaps> {
  const scope = window as MapsWindow;
  if (scope.google?.maps?.importLibrary) return Promise.resolve(scope.google);
  loading ??= new Promise<GoogleMaps>((resolve, reject) => {
    scope.__picklyMapsReady = () => (scope.google ? resolve(scope.google) : reject(new Error('Maps unavailable')));
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__picklyMapsReady&region=PH&language=en`;
    script.async = true;
    script.onerror = () => { loading = null; script.remove(); reject(new Error('Maps unavailable')); };
    document.head.appendChild(script);
  });
  return loading;
}

export function VenueMap({ apiKey, focus, onPinChange }: {
  apiKey: string;
  /** Recenter here (a chosen search result); `id` changes for each new focus. */
  focus: (LatLng & { id: number }) | null;
  /** Called after every move with the pin, whether the person moved the map themselves, and the zoom. */
  onPinChange: (pin: LatLng, moved: boolean, zoom: number) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<MapInstance | null>(null);
  const report = useRef(onPinChange);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => { report.current = onPinChange; });

  useEffect(() => {
    let cancelled = false;
    const listeners: Listener[] = [];
    (window as MapsWindow).gm_authFailure = () => { if (!cancelled) setState('failed'); };
    loadMaps(apiKey).then(async (google) => {
      const { Map } = await google.maps.importLibrary('maps');
      if (cancelled || !element.current) return;
      const instance = new Map(element.current, {
        center: PHILIPPINES, zoom: 5, gestureHandling: 'greedy', clickableIcons: false, streetViewControl: false,
        fullscreenControl: false, mapTypeControl: true, mapTypeControlOptions: { mapTypeIds: ['roadmap', 'hybrid'] },
        restriction: { latLngBounds: { south: 4, west: 116, north: 21.5, east: 127 }, strictBounds: false },
      });
      let moved = false;
      listeners.push(instance.addListener('dragstart', () => { moved = true; }));
      listeners.push(instance.addListener('click', (event) => {
        if (!event.latLng) return;
        moved = true;
        instance.panTo({ lat: event.latLng.lat(), lng: event.latLng.lng() });
      }));
      listeners.push(instance.addListener('idle', () => {
        const center = instance.getCenter();
        if (center) report.current({ lat: center.lat(), lng: center.lng() }, moved, instance.getZoom() ?? 0);
      }));
      map.current = instance;
      setState('ready');
    }).catch(() => { if (!cancelled) setState('failed'); });
    return () => { cancelled = true; for (const listener of listeners) listener.remove(); map.current = null; };
  }, [apiKey]);

  useEffect(() => {
    if (!focus || !map.current) return;
    map.current.setCenter({ lat: focus.lat, lng: focus.lng });
    map.current.setZoom(18);
  }, [focus, state]);

  return (
    <div className="map-frame">
      <div ref={element} className="map" role="application" aria-label="Map. Drag it, or tap a spot, so the pin sits on your courts." />
      {state === 'ready' && <>
        <span className="map-dot" aria-hidden="true" />
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed overlay graphic, not content */}
        <img className="map-pin" src="/court-pin.svg" alt="" />
      </>}
      {state !== 'ready' && <p className="map-message" role="status">{state === 'loading' ? 'Loading the map…' : 'The map couldn’t load. Check your connection and reload the page.'}</p>}
    </div>
  );
}
