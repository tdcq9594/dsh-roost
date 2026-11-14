/**
 * dsh-roost 扩展类型定义
 *
 * 本文件由 `scripts/build-ext-docs.mjs` **从源码生成**，不要手改。
 * 源码常量：`V1_SCOPES` / `REJECTION_LAYERS` / `EXT_ID_RE` / `ALLOWED_ENV_KEYS`。
 */

/** 扩展 id：小写字母开头，2–32 位，只含 `a-z0-9-`。必须等于目录名。 */
export type ExtensionId = string;

/** `/v1` 客户端 scope。 */
export type V1Scope =
  | 'message:write'
  | 'say:write'
  | 'state:read'
  | 'context:read'
  | 'memory:read'
  | 'memory:write'
  | 'proactive:write'
  | 'session:write'
  | 'prompt:write'
  | 'agent:write';

/** 需要单独确认的敏感 scope。 */
export type SensitiveScope =
  | 'agent:write'
  | 'say:write'
  | 'prompt:write'
  | 'proactive:write';

/** 拒绝诊断的五层来源。 */
export type RejectionLayer =
  | 'fence'
  | 'capabilities'
  | 'quota'
  | 'acl'
  | 'guard';

/** 受管块里允许出现的环境变量名（值由 launcher 注入，清单不许自带 env）。 */
export type ManagedEnvKey =
  | 'ROOST_API_URL'
  | 'ROOST_EXT_ID'
  | 'ROOST_LAUNCHER_DIR'
  | 'ROOST_DEPS_DIR';

export interface ExtensionMemoryConfig {
  /** 写入目标命名空间，形如 `ext:<id>`。 */
  writeTarget?: string;
  /** 可见性：`all` 表示其他档位也能读。 */
  visibility?: 'all' | 'owner' | 'private';
  /** 宿主清空会话 / 全局记忆时的行为。 */
  onClear?: 'keep' | 'clear';
  /** 单命名空间最多保留多少行。 */
  maxRows?: number;
}

/**
 * 一个可调设置字段的声明。面板据此渲染控件，宿主负责存储与下发。
 *
 * 类型对齐 `src/ext-config.js` 的 `CONFIG_TYPES`：`string` / `number` /
 * `boolean` / `select` / `array` / `object`。没有 `path` / `file`。
 */
export type ConfigField =
  | {
    type: 'string';
    label?: string;
    hint?: string;
    default?: string;
    required?: boolean;
    /** 值不进 `config.json`，单独存 `secrets/<id>.config.json`；只能放在顶层。 */
    secret?: boolean;
    maxLength?: number;
    placeholder?: string;
  }
  | {
    type: 'number';
    label?: string;
    hint?: string;
    default?: number;
    required?: boolean;
    min?: number;
    max?: number;
    /** `true` 时拒收小数。 */
    integer?: boolean;
  }
  | { type: 'boolean'; label?: string; hint?: string; default?: boolean; required?: boolean }
  | {
    type: 'select';
    label?: string;
    hint?: string;
    default?: string;
    required?: boolean;
    options: (string | { value: string; label?: string })[];
  }
  | {
    type: 'array';
    label?: string;
    hint?: string;
    default?: unknown[];
    required?: boolean;
    items?: { type: 'string' | 'number' | 'boolean' };
    maxItems?: number;
  }
  | {
    type: 'object';
    label?: string;
    hint?: string;
    required?: boolean;
    /** 子字段；嵌套最多 2 层，且不能标 `secret`。 */
    properties: Record<string, ConfigField>;
  };

export interface ExtensionManifest {
  /** 固定 `1`。 */
  api?: 1;
  /** 固定 `dsh-extension`（框架插件不带这个值）。 */
  kind?: 'dsh-extension';
  /** 必须等于目录名，正则 `^[a-z][a-z0-9-]{1,31}$`。 */
  id: ExtensionId;
  /** 必须等于 `id`：工具名 / section 名 / 组名全由 id 推导。 */
  serverName: ExtensionId;
  name: string;
  description: string;
  /** 可选，覆盖自动生成的能力说明（上限 200 字）。 */
  usage?: string;
  transport: 'stdio' | 'streamable-http';
  /** stdio 必填。 */
  command?: string;
  args?: string[];
  /** streamable-http 必填，且只认回环地址。 */
  url?: string;
  /** 只管 QQ 会话的工具可见性；独立会话工具全见。 */
  mounts?: string[];
  memory?: ExtensionMemoryConfig;
  /**
   * 可调设置声明：字段名 → 声明。最多 32 个字段。
   * 面板会画表单，值存宿主侧，启动时通过 `ROOST_EXT_CONFIG` /
   * `ROOST_EXT_SECRET_<KEY>` 下发。
   */
  config?: Record<string, ConfigField>;
  /** 市场元数据：本地完整性校验用。 */
  sha256?: string | null;
  size?: number;
  publishedAt?: string;
  /** `true` 表示被本地改过，不再参与更新校验。 */
  locallyModified?: boolean;
}

export interface V1ErrorBody {
  ok: false;
  error: string;
  message?: string;
}

export interface WhoAmI {
  ok: true;
  id: string;
  name: string;
  scopes: V1Scope[];
  /** 扩展令牌才有；面板发放的客户端为 `null`。 */
  extId: string | null;
}
