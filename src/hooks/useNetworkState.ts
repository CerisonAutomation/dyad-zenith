/**
 * Track network quality (online/offline, connection type, speed).
 * Useful for adjusting streaming behavior and showing connection indicators.
 *
 * @example
 * const { online, effectiveType, downlink } = useNetworkState();
 * if (!online) showOfflineBanner();
 */

import { useEffect, useState } from "react";

type NetworkState = {
  online: boolean;
  type: string | undefined;
  effectiveType: string | undefined;
  downlink: number | undefined;
  rtt: number | undefined;
  saveData: boolean | undefined;
};

export function useNetworkState(): NetworkState {
  const [state, setState] = useState<NetworkState>({
    online: navigator.onLine,
    type: undefined,
    effectiveType: undefined,
    downlink: undefined,
    rtt: undefined,
    saveData: false,
  });

  useEffect(() => {
    const connection = (navigator as any).connection;

    const updateNetworkInfo = () => {
      setState({
        online: navigator.onLine,
        type: connection?.type,
        effectiveType: connection?.effectiveType,
        downlink: connection?.downlink,
        rtt: connection?.rtt,
        saveData: connection?.saveData,
      });
    };

    window.addEventListener("online", updateNetworkInfo);
    window.addEventListener("offline", updateNetworkInfo);
    if (connection) {
      connection.addEventListener("change", updateNetworkInfo);
    }
    updateNetworkInfo();

    return () => {
      window.removeEventListener("online", updateNetworkInfo);
      window.removeEventListener("offline", updateNetworkInfo);
      if (connection) {
        connection.removeEventListener("change", updateNetworkInfo);
      }
    };
  }, []);

  return state;
}
