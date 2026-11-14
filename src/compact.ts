import { isUndefined, omitBy } from 'es-toolkit';

type UndefinedKey<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

type Compact<T> = Omit<T, UndefinedKey<T>> &
  Partial<{
    [K in UndefinedKey<T>]: Exclude<T[K], undefined>;
  }>;

export function compact<T extends Record<PropertyKey, unknown>>(value: T): Compact<T> {
  return omitBy(value, isUndefined) as Compact<T>;
}
