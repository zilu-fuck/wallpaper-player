"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.jsonSchema = exports.s = exports.ContractError = void 0;
class ContractError extends Error {
    code = 'invalid_request';
    status = 400;
    constructor(path, expectation) { super(`字段 ${path} ${expectation}`); this.name = 'ContractError'; }
}
exports.ContractError = ContractError;
function fail(path, expectation) { throw new ContractError(path, expectation); }
function schema(parse) {
    return { parse(value, path = 'data') { return parse(value, path); } };
}
exports.s = {
    string(max = 4096, min = 0) {
        return schema((value, path) => typeof value === 'string' && value.length >= min && value.length <= max
            ? value : fail(path, '必须是有效字符串'));
    },
    number(min = -Infinity, max = Infinity) {
        return schema((value, path) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
            ? value : fail(path, '必须是范围内的数值'));
    },
    integer(min = 0, max = Number.MAX_SAFE_INTEGER) {
        return schema((value, path) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
            ? value : fail(path, '必须是范围内的整数'));
    },
    boolean: schema((value, path) => typeof value === 'boolean' ? value : fail(path, '必须是布尔值')),
    literal(expected) {
        return schema((value, path) => value === expected ? expected : fail(path, '取值无效'));
    },
    enum(values) {
        return schema((value, path) => typeof value === 'string' && values.includes(value) ? value : fail(path, '取值无效'));
    },
    optional(inner) {
        return schema((value, path) => value === undefined ? undefined : inner.parse(value, path));
    },
    default(inner, fallback) {
        return schema((value, path) => inner.parse(value === undefined ? fallback : value, path));
    },
    nullable(inner) {
        return schema((value, path) => value === null ? null : inner.parse(value, path));
    },
    array(inner, max = 100000) {
        return schema((value, path) => Array.isArray(value) && value.length <= max
            ? value.map((item, index) => inner.parse(item, `${path}[${index}]`)) : fail(path, '必须是有效数组'));
    },
    object(shape, passthrough = false) {
        return schema((value, path) => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                fail(path, '必须是对象');
            const source = value;
            const parsed = passthrough ? { ...source } : {};
            for (const [key, field] of Object.entries(shape)) {
                const result = field.parse(source[key], `${path}.${key}`);
                if (result !== undefined)
                    parsed[key] = result;
            }
            return parsed;
        });
    },
    record(inner) {
        return schema((value, path) => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                fail(path, '必须是映射');
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inner.parse(item, `${path}.*`)]));
        });
    },
    union(...choices) {
        return schema((value, path) => {
            for (const choice of choices) {
                try {
                    return choice.parse(value, path);
                }
                catch (error) {
                    if (!(error instanceof ContractError))
                        throw error;
                }
            }
            return fail(path, '不符合支持的数据格式');
        });
    },
    refine(inner, predicate, expectation) {
        return schema((value, path) => { const result = inner.parse(value, path); return predicate(result) ? result : fail(path, expectation); });
    }
};
exports.jsonSchema = schema((value, path) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)))
        return value;
    if (Array.isArray(value))
        return value.map((item, index) => exports.jsonSchema.parse(item, `${path}[${index}]`));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exports.jsonSchema.parse(item, `${path}.*`)]));
    return fail(path, '必须是 JSON 数据');
});
