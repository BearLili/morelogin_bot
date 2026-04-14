/**
 * Discord 回合剧本解析（renderer 与 discord-roundtable.js 共用，避免规则漂移）
 *
 * 行格式：单字母角色 + 全角或半角冒号 + 正文，例如 A：你好 / F: hi
 * 角色列表 = 按剧本从上到下「首次出现」顺序去重后的字母序列。
 */

function parseRoundtableLines(text) {
  const lines = [];
  const rawLines = String(text).split('\n');
  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z])\s*[：:]\s*(.*)$/);
    if (!m) continue;
    const sp = String(m[1]).toUpperCase();
    const body = String(m[2] || '').trim();
    if (!body) continue;
    lines.push({ speaker: sp, text: body });
  }
  return lines;
}

function getRoleOrderFromLines(lines) {
  const order = [];
  const seen = new Set();
  for (const { speaker } of lines) {
    if (!seen.has(speaker)) {
      seen.add(speaker);
      order.push(speaker);
    }
  }
  return order;
}

function getRoleOrderFromDialogueText(text) {
  return getRoleOrderFromLines(parseRoundtableLines(text));
}

module.exports = {
  parseRoundtableLines,
  getRoleOrderFromLines,
  getRoleOrderFromDialogueText
};
