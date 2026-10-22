/**
 * 米游社撞验证码的提示文案。
 *
 * 自动过码没成功、或撞码自动处理被关掉时用：这种情况没有下一步指令可发，
 * 只能说「稍后再试」——不再引导用户去发已经删掉的手动过码。
 *
 * 单独抽出来是因为有两个调用方、两种排版：
 *   - apps/captchaNotice.js：Handler 提醒，单条消息，自己带 UID 前缀
 *   - utils/signClient.js：签到结果按「· UID：消息」逐行列，不能再带 UID
 * 所以这里只出正文，UID 由调用方决定加不加。
 */

export function captchaTip() {
  return '米游社暂时风控了，请稍后再试'
}
