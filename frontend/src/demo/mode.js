export function parseDemoMode(value) {
  return value === 'true';
}

export const isDemoMode = parseDemoMode(import.meta.env?.VITE_DEMO_MODE);
