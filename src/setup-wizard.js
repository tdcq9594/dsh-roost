/**
 * 首次接入向导
 * ============
 *
 * 参考 aurabot 的 `setupDone`：未完成向导时前端盖一层全屏遮罩，
 * 后端 `/done` 必须核对过连接才肯放行（不能靠前端说「我点完了」）。
 *
 * 两处刻意和 aurabot 不同：
 *
 * 1. **老用户升级也要重走**。aurabot 判断「老配置填过两个号 → 直接算完成」，
 *    但这一版删掉了 ai-chat，老配置的 `channel.current='qq'` 已经没有实现，
 *    不重新接一遍就是哑的。所以用 `WIZARD_VERSION` 递增版本而不是布尔：
 *    新装、老配置都停在 0，走完写 1；以后再出破坏性迁移 +1 即可。
 *
 * 2. **完成门槛是直连自测**，由后端真跑一次 `pairing.test()`，
 *    不是「填完表单」。避免「向导走完了机器人一个字都不回」。
 *    另给 `skip()`：老版本 Roost 没有外接协议时用户得能进面板去升级，
 *    不能被锁死；跳过只记版本号、不写 completed，概览页仍会催。
 */

import { WIZARD_VERSION } from './config.js';

/**
 * @param {object} o
 * @param {() => object} o.cfgOf     读当前配置
 * @param {(patch:object)=>object} o.setCfg  局部写配置（host.js 的 patchConfig 包装）
 * @param {object} o.pairing        createPairing() 实例（要 inspect / test）
 * @param {(m:string)=>void} [o.log]
 */
export function createSetupWizard({ cfgOf, setCfg, pairing, log = () => {} }) {
  const setupOf = () => cfgOf()?.setup ?? {};

  function state() {
    const done = Number(setupOf().wizardVersion ?? 0) >= WIZARD_VERSION;
    const skipped = Number(setupOf().wizardSkippedVersion ?? 0) >= WIZARD_VERSION;
    return {
      ok: true,
      version: WIZARD_VERSION,
      completed: done,
      /** 本版已跳过：前端不再盖全屏，但概览页要继续提示 */
      skipped,
      /** 该不该盖全屏遮罩。前端只认这一个字段，不自己拼判断 */
      needed: !done && !skipped,
      /**
       * 老配置有没有 ai-chat 痕迹：向导据此显示「你从旧版升级，需要重新接入」
       * 而不是「欢迎首次使用」。`readRawConfig()` 才有原始值，`loadConfig()`
       * 会把默认值合并进来，看不出用户当年选过什么。
       */
      upgraded: isUpgrade(),
    };
  }

  function isUpgrade() {
    /**
     * 必须**恒返回布尔**：`state()` 把它直接放进 `/status` 响应，
     * 返回 undefined 会让字段整个消失，前端拿到的是「没这个字段」而不是 false。
     *
     * 判据只看磁盘原始配置里有没有旧通道痕迹，或有没有一份「明显不是刚装的」
     * 配置（键多、且没走过任何一版向导）。不能用 `roostHost.url` 兜底：
     * 那个字段在全新装好但已点过一键直连时也会非空，会把新用户误判成升级。
     */
    const raw = cfgOf()?.__raw;
    if (!raw || typeof raw !== 'object') return false;
    if (String(raw.channel?.current || '') === 'qq') return true;
    const noWizardYet = raw.setup == null || raw.setup.wizardVersion === undefined;
    return Boolean(noWizardYet && Object.keys(raw).length > 3);
  }

  /**
   * 完成向导。**后端真跑一次直连自检**，前端传什么 true 都不算。
   *
   * 自检用 `pairing.test()`（打协议 `system.ping`），比只看配置字段可靠：
   * 配置写全了但 Roost 没开监听、token 对不上，这两种都通不过。
   */
  async function done({ force = false } = {}) {
    const cur = state();
    if (cur.completed) return { ...state(), message: '向导已经走完了' };

    /**
     * `force` 只给「暂时跳过」用，绝不写 completed。
     * 放在自测之前判断，免得自测失败时提前 return 把它吞掉。
     */
    if (force) return skip();

    let test;
    try {
      test = await pairing.test();
    } catch (e) {
      return {
        ...state(),
        ok: false,
        message: `直连自测没通过：${e?.message ?? e}。先在向导里点「一键直连」，再试一次。`,
        step: 'selftest',
      };
    }
    if (!test?.ok) {
      return { ...state(), ok: false, message: '直连自测没通过，先配对再完成向导。', step: 'selftest' };
    }

    setCfg({ setup: { ...setupOf(), wizardVersion: WIZARD_VERSION, wizardSkippedVersion: 0 } });
    log(`首次接入向导完成（v${WIZARD_VERSION}，直连自测 ${test?.ms ?? '?'}ms）`);
    return { ...state(), message: '接好了，去群里说一句话试试' };
  }

  /** 暂时跳过：本版不再盖全屏，但不算完成，概览页继续催 */
  function skip() {
    setCfg({ setup: { ...setupOf(), wizardSkippedVersion: WIZARD_VERSION } });
    log(`首次接入向导暂时跳过（v${WIZARD_VERSION}）`);
    return { ...state(), message: '先跳过。概览页会一直提示，随时可以回来接。' };
  }

  /** 重新打开向导（面板里的「重新检查接入」按钮） */
  function reopen() {
    setCfg({ setup: { ...setupOf(), wizardSkippedVersion: 0 } });
    return { ...state(), message: '向导已重新打开' };
  }

  return { state, done, skip, reopen };
}
