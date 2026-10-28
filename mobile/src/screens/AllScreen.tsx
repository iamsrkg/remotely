// Live overview of every paired computer at once. Tap one to take full control;
// the others stay connected in the background as low-bitrate thumbnails.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import type { Device } from '../lib/devices';
import type { Snapshot } from '../lib/connection';
import { closeAll, getSession, restartSession } from '../lib/sessions';
import { colors } from '../theme';

type Props = { devices: Device[]; onOpen: (d: Device) => void; onBack: () => void };

export default function AllScreen({ devices, onOpen, onBack }: Props) {
  useKeepAwake();
  const { width, height } = useWindowDimensions();
  const columns = width > height ? 2 : 1;
  const tileW = (width - 16 * 2 - 12 * (columns - 1)) / columns;

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={() => {
            closeAll();
            onBack();
          }}
          hitSlop={10}
        >
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>All computers</Text>
        <View style={{ width: 60 }} />
      </View>
      <ScrollView contentContainerStyle={[styles.grid, { gap: 12 }]}>
        {devices.map((d) => (
          <Tile key={d.id} device={d} width={tileW} onOpen={() => onOpen(d)} />
        ))}
      </ScrollView>
      <Text style={styles.hint}>Tap a computer to control it. The others stay connected.</Text>
    </SafeAreaView>
  );
}

function Tile({ device, width, onOpen }: { device: Device; width: number; onOpen: () => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const s = attempt === 0 ? getSession(device) : restartSession(device);
    const sync = () => setSnap({ ...s.snap });
    sync();
    s.send({ t: 'quality', q: 'thumb' });
    return s.subscribe({
      onStatus: sync,
      onStream: sync,
      onHello: () => {
        sync();
        s.send({ t: 'quality', q: 'thumb' });
      },
      onScreen: sync,
      onLatency: sync,
    });
  }, [device, attempt]);

  const ratio = snap?.screen ? snap.screen.w / snap.screen.h : 16 / 10;
  const height = width / ratio;
  const live = snap?.status === 'connected' && !!snap.streamUrl;
  const failed = snap?.status === 'failed';

  return (
    <Pressable onPress={failed ? () => setAttempt((a) => a + 1) : onOpen} style={{ width }}>
      <View style={[styles.screen, { height }]}>
        {live ? (
          <RTCView streamURL={snap!.streamUrl!} objectFit="contain" style={StyleSheet.absoluteFill} />
        ) : (
          <View style={styles.center}>
            {failed ? (
              <>
                <Text style={styles.failTitle}>Offline</Text>
                <Text style={styles.failText} numberOfLines={3}>
                  {snap?.detail}
                </Text>
                <Text style={styles.retry}>Tap to retry</Text>
              </>
            ) : (
              <ActivityIndicator color={colors.text} />
            )}
          </View>
        )}
      </View>
      <View style={styles.caption}>
        <View style={[styles.dot, { backgroundColor: live ? colors.ok : failed ? colors.bad : colors.warn }]} />
        <Text style={styles.name} numberOfLines={1}>
          {device.name}
        </Text>
        <Text style={styles.meta}>
          {live ? `${snap?.hello?.platform === 'darwin' ? 'Mac' : 'Windows'}${snap?.latency != null ? ` · ${snap.latency} ms` : ''}` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  back: { color: colors.accent, fontSize: 17, width: 60 },
  title: { color: colors.text, fontSize: 18, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 16 },
  screen: { backgroundColor: '#000', borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: colors.line },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12, gap: 4 },
  failTitle: { color: colors.text, fontWeight: '600' },
  failText: { color: colors.muted, textAlign: 'center', fontSize: 12 },
  retry: { color: colors.accent, marginTop: 4 },
  caption: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { color: colors.text, fontWeight: '600', flex: 1 },
  meta: { color: colors.muted, fontSize: 12 },
  hint: { color: colors.muted, textAlign: 'center', fontSize: 12, paddingBottom: 8 },
});
