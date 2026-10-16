import type { SVGProps } from 'react';

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...props
});

export const IconMonth = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 15l5-4 4 2 7-6" />
    <path d="M4 20h16" />
  </svg>
);
export const IconList = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1" />
    <circle cx="4.5" cy="12" r="1" />
    <circle cx="4.5" cy="18" r="1" />
  </svg>
);
export const IconImport = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5" />
    <path d="M5 19h14" />
  </svg>
);
export const IconSettings = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </svg>
);
export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 2.2, ...p })}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconChevron = ({ dir = 'right', ...p }: SVGProps<SVGSVGElement> & { dir?: 'left' | 'right' }) => (
  <svg {...base(p)}>
    <path d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
  </svg>
);
export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconChat = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M5 18.5V6a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H8.5L5 18.5z" />
    <path d="M9 9h6M9 12h4" />
  </svg>
);
export const IconMic = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" />
  </svg>
);
export const IconSend = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);
export const IconRepeat =(p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ width: 14, height: 14, ...p })}>
    <path d="M17 2l3 3-3 3" />
    <path d="M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3" />
    <path d="M20 13v2a4 4 0 01-4 4H4" />
  </svg>
);
