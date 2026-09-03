/**
 * Shared validation rules and types across client and server.
 * Ensures consistent cross-platform table name and identifier constraints.
 *
 * @module tetherdb/shared/validate
 */

/** Regular expression matching safe table names for cross-platform filesystem and storage safety. */
export const TABLE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Maximum allowed character length for table names. */
export const TABLE_NAME_MAX_LENGTH = 64;

/** Valid character set for compile-time table name validation. */
type ValidTableNameChar =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z'
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z'
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '_'
  | '-';

type ValidateChars<S extends string> =
  S extends `${ValidTableNameChar}${infer Rest}`
    ? ValidateChars<Rest>
    : S extends ''
      ? true
      : false;

type ValidateLength<
  S extends string,
  Count extends unknown[] = [],
> = Count['length'] extends 64
  ? S extends ''
    ? true
    : false
  : S extends `${string}${infer Rest}`
    ? ValidateLength<Rest, [...Count, unknown]>
    : true;

/**
 * TypeScript type helper validating table name literals at compile-time.
 * Accepts any valid string literal matching `/^[a-zA-Z0-9_-]{1,64}$/` or wide `string`.
 * Rejects empty strings, invalid characters, or strings longer than 64 characters.
 */
export type ValidTableName<T extends string> = string extends T
  ? T
  : T extends ''
    ? 'Error: Table name cannot be empty'
    : ValidateChars<T> extends false
      ? 'Error: Table name must only contain alphanumeric characters, underscores, and hyphens'
      : ValidateLength<T> extends false
        ? 'Error: Table name must not exceed 64 characters'
        : T;

/**
 * Validates whether the given value is a safe table name string.
 * Must be a string between 1 and 64 characters matching `/^[a-zA-Z0-9_-]{1,64}$/`.
 *
 * @param name - Value to inspect.
 * @returns `true` if name is a valid table name, `false` otherwise.
 */
export function isValidTableName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= TABLE_NAME_MAX_LENGTH &&
    TABLE_NAME_PATTERN.test(name)
  );
}
