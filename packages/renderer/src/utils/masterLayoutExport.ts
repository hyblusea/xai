/**
 * 导出 HTML 后处理（§6.7，renderer 端 DOMParser，D13）。
 *
 * 三个关键问题（§6.7.1）：
 * 1. 导出后菜单完整？✅ 快照版方案下 screen.html 已含注入后的菜单
 * 2. 导出后菜单能联动？❌ 导出 = 冻结快照，源 MasterLayout 修改不会同步
 * 3. 跳转链接需转换？✅ data-nav-target 是 designer runtime 用的，必须转 href
 *
 * 本函数处理第 3 点：data-nav-target → href 转换 + 清理设计期标记。
 */
import { parseHtml, serializeHtml } from './masterLayoutDom';
import type { DesignerProject } from '@xai/shared';

export interface ExportProcessOptions {
  /** 多文件模式：每 screen 一份 HTML；单文件模式：所有 screen 拼一份（anchor 跳转）。 */
  mode: 'single-file' | 'multi-file';
  /** 多文件模式下，screenId → 导出文件名映射（如 "用户管理.html"）。 */
  screenFileMap?: Map<string, string>;
}

/**
 * 导出 HTML 前的后处理：
 * 1. data-nav-target → href 转换（多文件用文件名，单文件用 anchor）
 * 2. 清理设计期标记（data-design-slot, data-design-id）
 * 3. 保留 data-nav-target 供用户后续手动修改跳转目标
 *
 * @param html      完整 HTML 文档字符串
 * @param screenId  当前 screen id（用于单文件模式 anchor 前缀）
 * @param project   项目（含 screens，用于查找 targetScreen）
 * @param opts      导出选项
 * @returns 处理后的 HTML
 */
export function processHtmlForExport(
  html: string,
  screenId: string,
  project: DesignerProject,
  opts: ExportProcessOptions,
): string {
  const doc = parseHtml(html);
  let changed = false;

  // 1. data-nav-target → href 转换
  const navTargets = doc.querySelectorAll('[data-nav-target]');
  navTargets.forEach(el => {
    const target = el.getAttribute('data-nav-target');
    if (!target) return;

    const targetScreen = project.screens.find(s => s.id === target);
    if (!targetScreen) {
      // 未绑定的菜单项：href="#"，导出后无效但不报错
      el.setAttribute('href', '#');
      changed = true;
      return;
    }

    if (opts.mode === 'multi-file') {
      const fileName = opts.screenFileMap?.get(target);
      if (fileName) {
        el.setAttribute('href', fileName);
        changed = true;
      }
    } else {
      // 单文件模式：用 anchor 跳转
      el.setAttribute('href', `#screen-${target}`);
      changed = true;
    }
  });

  // 2. 清理设计期标记（保留 data-nav-target 供用户后续修改）
  const slots = doc.querySelectorAll('[data-design-slot]');
  slots.forEach(el => {
    el.removeAttribute('data-design-slot');
    changed = true;
  });
  const designIds = doc.querySelectorAll('[data-design-id]');
  designIds.forEach(el => {
    el.removeAttribute('data-design-id');
    changed = true;
  });

  // 3. 单文件模式：为当前 screen 的 body 加 anchor 锚点
  if (opts.mode === 'single-file') {
    const body = doc.body;
    if (body && !body.querySelector(`#screen-${screenId}`)) {
      const anchor = doc.createElement('a');
      anchor.id = `screen-${screenId}`;
      body.insertBefore(anchor, body.firstChild);
      changed = true;
    }
  }

  return changed ? serializeHtml(doc) : html;
}

/**
 * 构造 screenId → 导出文件名映射（多文件模式用）。
 * 文件名基于 screen.name，做安全转义（去除非法字符）。
 */
export function buildScreenFileMap(
  screens: { id: string; name: string }[],
): Map<string, string> {
  const map = new Map<string, string>();
  const usedNames = new Set<string>();

  for (const s of screens) {
    const safeName = (s.name || 'untitled')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim() || 'untitled';
    let fileName = `${safeName}.html`;
    let n = 1;
    while (usedNames.has(fileName.toLowerCase())) {
      fileName = `${safeName}_${n}.html`;
      n++;
    }
    usedNames.add(fileName.toLowerCase());
    map.set(s.id, fileName);
  }

  return map;
}
