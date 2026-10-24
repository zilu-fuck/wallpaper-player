export interface Schema<T> { parse(value: unknown, path?: string): T }
export type Infer<S> = S extends Schema<infer T> ? T : never
type Shape = Record<string, Schema<unknown>>
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S]
type ObjectValue<S extends Shape> = { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } &
  { [K in OptionalKeys<S>]?: Infer<S[K]> }

export class ContractError extends Error {
  code = 'invalid_request'
  status = 400
  constructor(path: string, expectation: string) { super(`字段 ${path} ${expectation}`); this.name = 'ContractError' }
}
function fail(path: string, expectation: string): never { throw new ContractError(path, expectation) }
function schema<T>(parse: (value: unknown, path: string) => T): Schema<T> {
  return { parse(value, path = 'data') { return parse(value, path) } }
}

export const s = {
  string(max = 4096, min = 0): Schema<string> {
    return schema((value, path) => typeof value === 'string' && value.length >= min && value.length <= max
      ? value : fail(path, '必须是有效字符串'))
  },
  number(min = -Infinity, max = Infinity): Schema<number> {
    return schema((value, path) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
      ? value : fail(path, '必须是范围内的数值'))
  },
  integer(min = 0, max = Number.MAX_SAFE_INTEGER): Schema<number> {
    return schema((value, path) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
      ? value : fail(path, '必须是范围内的整数'))
  },
  boolean: schema<boolean>((value, path) => typeof value === 'boolean' ? value : fail(path, '必须是布尔值')),
  literal<T extends string | number | boolean | null>(expected: T): Schema<T> {
    return schema((value, path) => value === expected ? expected : fail(path, '取值无效'))
  },
  enum<const T extends readonly string[]>(values: T): Schema<T[number]> {
    return schema((value, path) => typeof value === 'string' && values.includes(value) ? value : fail(path, '取值无效'))
  },
  optional<T>(inner: Schema<T>): Schema<T | undefined> {
    return schema((value, path) => value === undefined ? undefined : inner.parse(value, path))
  },
  default<T>(inner: Schema<T>, fallback: T): Schema<T> {
    return schema((value, path) => inner.parse(value === undefined ? fallback : value, path))
  },
  nullable<T>(inner: Schema<T>): Schema<T | null> {
    return schema((value, path) => value === null ? null : inner.parse(value, path))
  },
  array<T>(inner: Schema<T>, max = 100000): Schema<T[]> {
    return schema((value, path) => Array.isArray(value) && value.length <= max
      ? value.map((item, index) => inner.parse(item, `${path}[${index}]`)) : fail(path, '必须是有效数组'))
  },
  object<S extends Shape>(shape: S, passthrough = false): Schema<ObjectValue<S>> {
    return schema((value, path) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '必须是对象')
      const source = value as Record<string, unknown>
      const parsed: Record<string, unknown> = passthrough ? { ...source } : {}
      for (const [key, field] of Object.entries(shape)) {
        const result = field.parse(source[key], `${path}.${key}`)
        if (result !== undefined) parsed[key] = result
      }
      return parsed as ObjectValue<S>
    })
  },
  record<T>(inner: Schema<T>): Schema<Record<string, T>> {
    return schema((value, path) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '必须是映射')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inner.parse(item, `${path}.*`)]))
    })
  },
  union<const T extends readonly Schema<unknown>[]>(...choices: T): Schema<Infer<T[number]>> {
    return schema((value, path) => {
      for (const choice of choices) {
        try { return choice.parse(value, path) as Infer<T[number]> } catch (error) { if (!(error instanceof ContractError)) throw error }
      }
      return fail(path, '不符合支持的数据格式')
    })
  },
  refine<T>(inner: Schema<T>, predicate: (value: T) => boolean, expectation: string): Schema<T> {
    return schema((value, path) => { const result = inner.parse(value, path); return predicate(result) ? result : fail(path, expectation) })
  }
}

export const jsonSchema: Schema<unknown> = schema((value, path) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))) return value
  if (Array.isArray(value)) return value.map((item, index) => jsonSchema.parse(item, `${path}[${index}]`))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, jsonSchema.parse(item, `${path}.*`)]))
  return fail(path, '必须是 JSON 数据')
})
