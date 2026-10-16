import { useEffect, useState } from 'react';

/** true quando `active` continua verdadeiro por mais de `ms` (para avisar que o servidor gratuito está acordando). */
export function useSlow(active: boolean, ms = 4000) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return slow;
}

export const WAKING_MESSAGE = 'O servidor gratuito estava em repouso e está acordando. Isso pode levar até um minuto na primeira vez.';
