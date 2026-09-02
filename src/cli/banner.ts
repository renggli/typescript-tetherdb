import {
  ANSI_COLOR_1,
  ANSI_COLOR_2,
  ANSI_COLOR_3,
  ANSI_COLOR_4,
  ANSI_COLOR_5,
  ANSI_MUTED,
  ANSI_RESET,
} from '../shared/ansi.js';

export {
  ANSI_BOLD,
  ANSI_COLOR_1,
  ANSI_COLOR_2,
  ANSI_COLOR_3,
  ANSI_COLOR_4,
  ANSI_COLOR_5,
  ANSI_CYAN,
  ANSI_DIM,
  ANSI_MUTED,
  ANSI_RESET,
} from '../shared/ansi.js';

/**
 * Returns the styled ASCII banner for TetherDB CLI.
 *
 * @returns Colored ASCII art logo string.
 */
export function getBanner(): string {
  return [
    `${ANSI_COLOR_1}   ______     __  __               ____  ____  ${ANSI_RESET}`,
    `${ANSI_COLOR_2}  /_  __/__  / /_/ /_  ___  _____ / __ \\/ __ ) ${ANSI_RESET}`,
    `${ANSI_COLOR_3}   / / / _ \\/ __/ __ \\/ _ \\/ ___// / / / __  | ${ANSI_RESET}`,
    `${ANSI_COLOR_4}  / / /  __/ /_/ / / /  __/ /   / /_/ / /_/ /  ${ANSI_RESET}`,
    `${ANSI_COLOR_5} /_/  \\___/\\__/_/ /_/\\___/_/   /_____/_____/   ${ANSI_RESET}`,
    `${ANSI_MUTED}  ⚡ Local-first real-time database${ANSI_RESET}`,
  ].join('\n');
}
