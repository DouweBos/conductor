export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type Direction = 'down' | 'up' | 'left' | 'right';

export function swipeCoords(dir: Direction): {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
} {
  switch (dir) {
    case 'down':
      return { startX: 0.5, startY: 0.7, endX: 0.5, endY: 0.3 };
    case 'up':
      return { startX: 0.5, startY: 0.3, endX: 0.5, endY: 0.7 };
    case 'left':
      return { startX: 0.8, startY: 0.5, endX: 0.2, endY: 0.5 };
    case 'right':
      return { startX: 0.2, startY: 0.5, endX: 0.8, endY: 0.5 };
  }
}
