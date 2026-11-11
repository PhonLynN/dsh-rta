/**
 * host/define-tool.js — `@deepseek-ai/dsh-tools` 的离线兜底。
 *
 * 改编自 dsh-video-storyboard 的 src/define-tool.js（Apache-2.0，见 NOTICE）。
 *
 * 为什么需要它：宿主的 `@deepseek-ai/dsh-tools` 被打包进 app.asar，插件从自己的
 * node_modules 往上解析时经常找不到 —— import 抛错会被 apply 的 catch 吞掉，
 * 结果是整个插件静默不注册任何工具。
 *
 * 这里只做「author spec → 宿主认的 JSON Schema」的编译，不做运行时参数校验。
 * 首选仍然是宿主版本（见 src/index.js 的 loadDefineTool）。
 */

const AUTHOR_ONLY_JSON = 'json';

function compilePropertyMap(map, path) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error(`${path} 必须是对象（属性名 → 值 schema）`);
  }
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(map)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`${path}.${key} 必须是值 schema 对象`);
    }
    const { required: mark, ...rest } = spec;
    if (mark !== undefined && mark !== true) throw new Error(`${path}.${key}.required 写了就只能是 true`);
    if (mark === true) required.push(key);
    properties[key] = compileValue(rest, `${path}.${key}`);
  }
  return required.length > 0 ? { properties, required } : { properties };
}

function compileValue(spec, path) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${path} 必须是值 schema 对象`);
  }
  const out = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'required') continue; // 由 compilePropertyMap 提走
    if (key === 'properties') {
      const compiled = compilePropertyMap(value, `${path}.properties`);
      out.properties = compiled.properties;
      if (compiled.required) out.required = compiled.required;
      continue;
    }
    if (key === 'items') {
      out.items = compileValue(value, `${path}.items`);
      continue;
    }
    // author-only：任意 JSON。宿主把它变成「只有注解、没有 type」的 schema
    if (key === 'type' && value === AUTHOR_ONLY_JSON) continue;
    out[key] = value;
  }
  return out;
}

/** 编译 `parameters`：隐式开放对象，根上不写 required（除非属性显式标了）。 */
export function parametersToJsonSchema(spec) {
  const { properties, required } = compilePropertyMap(spec, 'parameters');
  return { type: 'object', properties, ...(required ? { required } : {}) };
}

/** 编译 `output.schema`。 */
export function outputSchemaToJsonSchema(spec) {
  return compileValue(spec, 'schema');
}

/** `defineTool` 的兜底实现：签名和返回值与宿主一致，只是不做运行时参数校验。 */
export function defineToolCompat(options) {
  if (!options || typeof options !== 'object') throw new Error('defineTool: options 必须是对象');
  const { name, description, parameters, output, execute } = options;
  if (typeof name !== 'string' || !name) throw new Error('defineTool: name 必须是非空字符串');
  if (!output || typeof output !== 'object') throw new Error(`defineTool(${name}): 缺 output`);
  if (typeof output.render !== 'function') throw new Error(`defineTool(${name}): output.render 必须是函数`);
  if (typeof execute !== 'function') throw new Error(`defineTool(${name}): execute 必须是函数`);
  if (options.timeoutMs !== undefined
    && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${name}): timeoutMs 必须是正数`);
  }

  const tool = {
    name,
    description,
    parameters: parametersToJsonSchema(parameters ?? {}),
    output: {
      schema: outputSchemaToJsonSchema(output.schema ?? {}),
      render: output.render,
      ...(typeof output.presentationMeta === 'function' ? { presentationMeta: output.presentationMeta } : {}),
    },
    ...(options.deferLoading === true ? { deferLoading: true } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      return execute(args, exec);
    },
  };
  if (typeof options.projectContent === 'function') tool.projectContent = options.projectContent;
  if (typeof options.finalizeContent === 'function') tool.finalizeContent = options.finalizeContent;
  if (typeof options.presentCall === 'function') tool.presentCall = options.presentCall;
  if (typeof options.presentResult === 'function') tool.presentResult = options.presentResult;
  if (typeof options.isConcurrencySafe === 'function') tool.isConcurrencySafe = options.isConcurrencySafe;
  return tool;
}
