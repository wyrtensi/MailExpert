import { useEffect, useState } from 'react';

// True once `active` has lasted `afterMs`: the "still checking" note of a check that can take up to
// 35 seconds. Resets when the check ends.
export default function useSlowFlag(active, afterMs) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) { setSlow(false); return undefined; }
    const timer = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(timer);
  }, [active, afterMs]);
  return slow;
}
