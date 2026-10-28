import { useEffect, useState } from 'react';
import { BackHandler } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { Device } from './src/lib/devices';
import AllScreen from './src/screens/AllScreen';
import HomeScreen from './src/screens/HomeScreen';
import ScanScreen from './src/screens/ScanScreen';
import SessionScreen from './src/screens/SessionScreen';
import { closeAll } from './src/lib/sessions';

type Route =
  | { name: 'home' }
  | { name: 'scan' }
  | { name: 'all'; devices: Device[] }
  | { name: 'session'; device: Device; from?: Device[] };

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const home = () => setRoute({ name: 'home' });

  // Android back button walks back through the screens.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'home') return false;
      if (route.name === 'session' && route.from) setRoute({ name: 'all', devices: route.from });
      else {
        if (route.name === 'all') closeAll();
        home();
      }
      return true;
    });
    return () => sub.remove();
  }, [route]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" hidden={route.name === 'session'} />
      {route.name === 'home' && (
        <HomeScreen
          onScan={() => setRoute({ name: 'scan' })}
          onConnect={(device) => setRoute({ name: 'session', device })}
          onViewAll={(devices) => setRoute({ name: 'all', devices })}
        />
      )}
      {route.name === 'scan' && <ScanScreen onDone={home} />}
      {route.name === 'all' && (
        <AllScreen
          devices={route.devices}
          onBack={home}
          onOpen={(device) => setRoute({ name: 'session', device, from: route.devices })}
        />
      )}
      {route.name === 'session' && (
        <SessionScreen
          key={route.device.id}
          device={route.device}
          keepAlive={!!route.from}
          onExit={() => (route.from ? setRoute({ name: 'all', devices: route.from }) : home())}
        />
      )}
    </SafeAreaProvider>
  );
}
