import { useEffect, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Device, loadDevices, parsePairingCode, removeDevice, upsertDevice } from '../lib/devices';
import { colors } from '../theme';

type Props = { onScan: () => void; onConnect: (d: Device) => void; onViewAll: (devices: Device[]) => void };

export default function HomeScreen({ onScan, onConnect, onViewAll }: Props) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [pasting, setPasting] = useState(false);
  const [code, setCode] = useState('');

  useEffect(() => {
    loadDevices().then(setDevices);
  }, []);

  const confirmRemove = (d: Device) =>
    Alert.alert('Remove computer?', `${d.name} will need to be paired again.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => setDevices(await removeDevice(d.id)) },
    ]);

  const addFromCode = async () => {
    try {
      const d = parsePairingCode(code);
      setDevices(await upsertDevice(d));
      setPasting(false);
      setCode('');
    } catch (e: any) {
      Alert.alert('Invalid code', e.message);
    }
  };

  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.title}>Remotely</Text>
      <Text style={styles.subtitle}>Control your Mac or PC from this phone.</Text>

      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        contentContainerStyle={{ gap: 10, paddingVertical: 16 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No computers yet</Text>
            <Text style={styles.muted}>
              Install Remotely on your Mac or Windows PC, open it, then tap "Add computer" and scan the QR code.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
            onPress={() => onConnect(item)}
            onLongPress={() => confirmRemove(item)}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{item.name}</Text>
              <Text style={styles.muted}>
                ID {item.id.replace(/(\d{3})(?=\d)/g, '$1 ')} · {item.server ? 'Wi-Fi + Internet' : 'Wi-Fi only'}
              </Text>
            </View>
            <Text style={styles.chev}>›</Text>
          </Pressable>
        )}
      />

      {devices.length > 0 && <Text style={[styles.muted, styles.hint]}>Long-press a computer to remove it.</Text>}

      {devices.length > 1 && (
        <Pressable style={styles.primary} onPress={() => onViewAll(devices)}>
          <Text style={styles.primaryText}>View all {devices.length} computers live</Text>
        </Pressable>
      )}
      <Pressable style={devices.length > 1 ? styles.secondary : styles.primary} onPress={onScan}>
        <Text style={devices.length > 1 ? styles.secondaryText : styles.primaryText}>Add computer</Text>
      </Pressable>
      <Pressable style={styles.secondary} onPress={() => setPasting(true)}>
        <Text style={styles.secondaryText}>Paste pairing code</Text>
      </Pressable>

      <Modal visible={pasting} transparent animationType="fade" onRequestClose={() => setPasting(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modal}>
            <Text style={styles.cardTitle}>Paste pairing code</Text>
            <Text style={styles.muted}>On the computer, click "Copy pairing code" and send it to this phone.</Text>
            <TextInput
              style={styles.input}
              value={code}
              onChangeText={setCode}
              placeholder="eyJ2Ijox…"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable style={[styles.secondary, { flex: 1 }]} onPress={() => setPasting(false)}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.primary, { flex: 1 }]} onPress={addFromCode}>
                <Text style={styles.primaryText}>Add</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20, paddingBottom: 12 },
  title: { color: colors.text, fontSize: 30, fontWeight: '700', marginTop: 12 },
  subtitle: { color: colors.muted, marginTop: 4 },
  muted: { color: colors.muted, lineHeight: 20 },
  hint: { textAlign: 'center', marginBottom: 10, fontSize: 12 },
  empty: { backgroundColor: colors.card, borderRadius: 14, padding: 20, gap: 6, borderWidth: 1, borderColor: colors.line },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '600' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
  },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '600', marginBottom: 2 },
  chev: { color: colors.muted, fontSize: 28 },
  primary: { backgroundColor: colors.accent, borderRadius: 12, padding: 15, alignItems: 'center', marginBottom: 10 },
  primaryText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  secondary: { borderRadius: 12, padding: 15, alignItems: 'center', borderWidth: 1, borderColor: colors.line, marginBottom: 10 },
  secondaryText: { color: colors.text, fontWeight: '500', fontSize: 16 },
  modalBg: { flex: 1, backgroundColor: '#000a', justifyContent: 'center', padding: 20 },
  modal: { backgroundColor: colors.card, borderRadius: 16, padding: 20, gap: 12 },
  input: {
    backgroundColor: colors.bg,
    color: colors.text,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 12,
    minHeight: 90,
    textAlignVertical: 'top',
  },
});
