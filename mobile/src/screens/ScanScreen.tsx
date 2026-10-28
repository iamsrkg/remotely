import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { parsePairingCode, upsertDevice } from '../lib/devices';
import { colors } from '../theme';

export default function ScanScreen({ onDone }: { onDone: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  const onScanned = async ({ data }: { data: string }) => {
    if (handled.current) return;
    try {
      const device = parsePairingCode(data);
      handled.current = true;
      await upsertDevice(device);
      onDone();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (!permission) return <View style={styles.root} />;

  return (
    <SafeAreaView style={styles.root}>
      {permission.granted ? (
        <View style={styles.cameraWrap}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScanned}
          />
          <View style={styles.frame} pointerEvents="none" />
        </View>
      ) : (
        <View style={styles.center}>
          <Text style={styles.text}>Camera access is needed to scan the pairing QR code.</Text>
          <Pressable style={styles.button} onPress={requestPermission}>
            <Text style={styles.buttonText}>Allow camera</Text>
          </Pressable>
        </View>
      )}
      <Text style={styles.text}>{error ?? 'Point the camera at the QR code in the Remotely app on your computer.'}</Text>
      <Pressable style={[styles.button, styles.cancel]} onPress={onDone}>
        <Text style={styles.buttonText}>Cancel</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 20, gap: 16 },
  cameraWrap: { flex: 1, borderRadius: 16, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  frame: { width: 240, height: 240, borderWidth: 3, borderColor: '#fff', borderRadius: 20 },
  center: { flex: 1, justifyContent: 'center', gap: 16 },
  text: { color: colors.text, textAlign: 'center', fontSize: 15, lineHeight: 21 },
  button: { backgroundColor: colors.accent, borderRadius: 12, padding: 15, alignItems: 'center' },
  cancel: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.line },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});
