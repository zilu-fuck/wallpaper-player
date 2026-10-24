export interface Schema<T> {
    parse(value: unknown, path?: string): T;
}
export type Infer<S> = S extends Schema<infer T> ? T : never;
type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = {
    [K in keyof S]: undefined extends Infer<S[K]> ? K : never;
}[keyof S];
type ObjectValue<S extends Shape> = {
    [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]>;
} & {
    [K in OptionalKeys<S>]?: Infer<S[K]>;
};
export declare class ContractError extends Error {
    code: string;
    status: number;
    constructor(path: string, expectation: string);
}
export declare const s: {
    string(max?: number, min?: number): Schema<string>;
    number(min?: number, max?: number): Schema<number>;
    integer(min?: number, max?: number): Schema<number>;
    boolean: Schema<boolean>;
    literal<T extends string | number | boolean | null>(expected: T): Schema<T>;
    enum<const T extends readonly string[]>(values: T): Schema<T[number]>;
    optional<T>(inner: Schema<T>): Schema<T | undefined>;
    default<T>(inner: Schema<T>, fallback: T): Schema<T>;
    nullable<T>(inner: Schema<T>): Schema<T | null>;
    array<T>(inner: Schema<T>, max?: number): Schema<T[]>;
    object<S extends Shape>(shape: S, passthrough?: boolean): Schema<ObjectValue<S>>;
    record<T>(inner: Schema<T>): Schema<Record<string, T>>;
    union<const T extends readonly Schema<unknown>[]>(...choices: T): Schema<Infer<T[number]>>;
    refine<T>(inner: Schema<T>, predicate: (value: T) => boolean, expectation: string): Schema<T>;
};
export declare const jsonSchema: Schema<unknown>;
export {};
