/**
 * 菜单/链接标签 ↔ 页面名 匹配评分（共享纯函数）。
 *
 * 复用 DesignerCanvas 按钮智能跳转的匹配规则（单一事实源），供三处共用：
 *   1. DesignerCanvas 按钮点击 → 跳转目标屏幕
 *   2. 共享母版注入 → 高亮当前页对应菜单项（renderer DOMParser + electron cheerio）
 *   3. autoBindPendingMenuItems → 把匹配到的待绑定项标记为已绑定
 *
 * 规则：精确 → 双向 includes 模糊；标签为空 / 长度 < 2 / 纯数字 → NONE
 * （避免分页页码、单字符误命中）。screenName 可含 AI 拼接的系统名/日期后缀
 * （如 "计划排产 - 热轧MES系统 — 7/29 14:32"），FUZZY 经 screenName.includes(label)
 * 命中——后缀反而有助于消歧（"管理 - 热轧MES系统…" 不含 "用户管理"）。
 */

/** 匹配分值（越大越优）。 */
export const MENU_MATCH_SCORE = {
  NONE: 0,
  FUZZY: 1,
  EXACT: 2,
} as const;

/** 规范化：trim + lowercase。 */
function norm(s: string | undefined | null): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * 判断 label 与 screenName 的匹配分值。
 *
 * @returns
 *   - EXACT (2)：normalize(label) === normalize(screenName)
 *   - FUZZY (1)：双向 includes（label ⊆ screenName 或 screenName ⊆ label）
 *   - NONE (0)：不匹配 / 标签过短 / 纯数字
 */
export function scoreMenuMatch(label: string, screenName: string): number {
  const l = norm(label);
  const s = norm(screenName);
  if (!l || !s) return MENU_MATCH_SCORE.NONE;
  // 长度 < 2 / 纯数字跳过：分页按钮 "1"~"6" 等单字符或纯页码无语义，
  // 双向 includes 易误命中名字含该字符的屏幕。
  if (l.length < 2) return MENU_MATCH_SCORE.NONE;
  if (/^\d+$/.test(l)) return MENU_MATCH_SCORE.NONE;
  if (l === s) return MENU_MATCH_SCORE.EXACT;
  if (s.includes(l) || l.includes(s)) return MENU_MATCH_SCORE.FUZZY;
  return MENU_MATCH_SCORE.NONE;
}
