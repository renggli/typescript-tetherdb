/**
 * ASCII logo and brand styling for TetherDB CLI matching the application color gradient (#0284c7 → #6366f1).
 */

export const ANSI_COLOR_1 = '\x1b[38;2;2;132;199m'; // #0284c7 (Sky Blue)
export const ANSI_COLOR_2 = '\x1b[38;2;26;125;209m';
export const ANSI_COLOR_3 = '\x1b[38;2;50;117;220m';
export const ANSI_COLOR_4 = '\x1b[38;2;75;110;230m';
export const ANSI_COLOR_5 = '\x1b[38;2;99;102;241m'; // #6366f1 (Indigo)
export const ANSI_MUTED = '\x1b[38;2;129;140;248m';
export const ANSI_BOLD = '\x1b[1m';
export const ANSI_DIM = '\x1b[2m';
export const ANSI_CYAN = '\x1b[36m';
export const ANSI_RESET = '\x1b[0m';

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
