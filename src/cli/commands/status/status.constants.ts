export const STATUS_REFRESH_INTERVAL_MS = 1_000;

export const QUIT_KEY_Q = 'q';
export const QUIT_KEY_ESCAPE = String.fromCharCode(27);
export const QUIT_KEY_CTRL_C = String.fromCharCode(3);
export const QUIT_KEY_CTRL_D = String.fromCharCode(4);

export const QUIT_KEYS: readonly string[] = [
  QUIT_KEY_Q,
  QUIT_KEY_ESCAPE,
  QUIT_KEY_CTRL_C,
  QUIT_KEY_CTRL_D,
];

const ESC = String.fromCharCode(27);

export const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;
