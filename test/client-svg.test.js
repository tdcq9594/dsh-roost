// 二维码 SVG 的白名单剥离。
//
// 面板用 `dangerouslySetInnerHTML` 把宿主给的 SVG 插进去，`safeSvg` 是唯一
// 一道门。2026-11 审查发现它能被**自嵌套**绕过：`<scr<script>ipt>` 剥掉内层
// 之后，剩下的两半正好拼回一个完整的 `<script>`。修法是反复剥到稳定。
//
// 这里不引整个面板，直接把那段函数从源码里抠出来跑——`safeSvg` 是纯函数，
// 抠出来测比造一整个 React 环境便宜得多。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

/** 抠出 `const safeSvg = (s) => { ... }` 的函数体（按缩进找收尾的 `}`） */
function loadSafeSvg() {
  const start = SRC.indexOf('const safeSvg = (s) => {');
  assert.ok(start > 0, '找不到 safeSvg 的定义');
  const bodyStart = SRC.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < SRC.length; i += 1) {
    const c = SRC[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > bodyStart, 'safeSvg 的函数体没闭合');
  const code = SRC.slice(start, end).replace('const safeSvg =', 'return');
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

const safeSvg = loadSafeSvg();

test('二维码 SVG：普通内容原样保留', () => {
  const ok = '<svg viewBox="0 0 10 10"><rect x="0" y="0" width="1" height="1"/></svg>';
  assert.equal(safeSvg(ok), ok);
});

test('二维码 SVG：脚本、事件、外链都要剥掉', () => {
  assert.equal(safeSvg('<svg><script>alert(1)</script></svg>'), '<svg></svg>');
  assert.equal(
    safeSvg('<svg onload="alert(1)"><rect/></svg>'),
    '<svg><rect/></svg>',
    '内联事件要剥',
  );
  assert.equal(
    safeSvg('<svg><a href="javascript:alert(1)"><rect/></a></svg>'),
    '<svg><a><rect/></a></svg>',
    '链接要剥（二维码不需要）',
  );
});

test('二维码 SVG：自嵌套不能拼回标签（2026-11 绕过的形态）', () => {
  const a = safeSvg('<svg><scr<script>ipt>alert(1)</scr<script>ipt></svg>');
  assert.equal(a.toLowerCase().includes('<script'), false, `还留着 <script：${a}`);

  const b = safeSvg('<svg><ifra<iframe>me src="//x"></ifra<iframe>me></svg>');
  assert.equal(b.toLowerCase().includes('<iframe'), false, `还留着 <iframe：${b}`);
});

test('二维码 SVG：属性前用 / 分隔也要挡住（<svg/onload=…>）', () => {
  /**
   * HTML tokenizer 在属性名前的 `/` 会退化成属性分隔符，等价于空格。
   * 以前正则要求前导 `\s`，`<svg/onload=alert(1)>` 能原样留下。
   */
  const a = safeSvg('<svg/onload=alert(1)></svg>');
  assert.equal(/onload/i.test(a), false, `onload 还在：${a}`);

  const b = safeSvg('<svg><image/href="javascript:alert(1)"/></svg>');
  assert.equal(/javascript:/i.test(b), false, `javascript: 还在：${b}`);
});

test('二维码 SVG：深嵌套剥不干净时 fail-closed（宁可空白也不要 XSS）', () => {
  /** 每轮只收敛一层；十几层就能撞上迭代上限，这时必须一个字都不给 */
  const deep = `<svg>${'<scr'.repeat(20)}<script>alert(1)</script>${'ipt>'.repeat(20)}</svg>`;
  const out = safeSvg(deep);
  assert.equal(/<\s*script/i.test(out), false, `深嵌套漏出 <script：${out.slice(0, 80)}`);
});

test('二维码 SVG：没有 svg 标签就返回空串（不把任意 HTML 塞进去）', () => {
  assert.equal(safeSvg('<div>hi</div>'), '');
  assert.equal(safeSvg(''), '');
  assert.equal(safeSvg(null), '');
});
