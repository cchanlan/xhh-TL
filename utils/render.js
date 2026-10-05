/**
 * 全插件统一出图入口。
 *
 * 收敛此前散落在 20+ 个 app 里那段几乎一字不差的样板：
 *   e.runtime.render(...) → extractRenderBuffer → toWebp → replyQuote(segment.image)
 * 以后 webp 参数、缩放注入、回复方式、buffer 提取、错误兜底、外置渲染适配，
 * 改这一处就全插件生效，不必再逐个 app 复制粘贴。
 *
 * 缩放注入两种形态，由 opts.rem 决定哪种生效：
 *   - data.scalePx：数值倍率，始终注入。rem 模板用它做 `html{font-size}`；
 *     transform 模板不读它，留着无害。
 *   - data.sys.scale：defaultLayout 的 `<body {{sys.scale}}>` 会无条件套用。
 *     transform 模板需要它=`style=transform:scale(x)`；rem 模板必须置空，
 *     否则 rem 之上再叠一层 transform = 双重缩放。
 *
 * 迁移期两种模板并存：Phase 2 每把一个模板转成 rem，就把它的调用点翻成 rem:true。
 * 全部转完后即可删掉 transform 分支。
 *
 * ## 出图格式
 *
 * 统一读锅巴「出图 → 输出图片类型」（配置项 `img_type`，见 pluginConfig.getImageFormat），
 * 全插件所有出图点都走这里，不再各自写死 webp。
 *
 * 渲染器那一步**始终让它出无损 png**，再在插件侧用 sharp 编成目标格式：
 * 一来 png 无损，二次编码不累积失真；二来 jpeg 能顺手用上 mozjpeg（同画质小约 18%），
 * 而渲染器内置编码器给不了这些。sharp 缺失时只能退回渲染器直接出目标格式 ——
 * 那时 jpeg/webp 用 Chromium 内置编码器，png 本来也无损，效果都能接受。
 */
import { config, getRenderScaleValue, getRenderScaleStyle, getImageFormat } from './pluginConfig.js'
import { extractRenderBuffer, encodeImage, hasSharp } from './renderImage.js'
import { replyQuote, replyForward } from './replyHelper.js'

const PLUGIN = 'xhh-TL'

/** 模板里拼资源路径用的相对前缀；渲染产物固定落在 temp/html/<plugin>/<单段路径>/ 下，深度恒定 */
function resPrefix(plugin) {
  return `../../../../plugins/${plugin}/resources/`
}

/**
 * 渲染模板并出图。
 *
 * @param {object} e 消息事件
 * @param {object} opts
 * @param {string} opts.tpl        渲染路径（单段，如 'hold_rate'），同时作默认 saveId
 * @param {object} opts.data       模板数据
 * @param {string} [opts.plugin]   宿主插件名，默认 xhh-TL
 * @param {string} opts.tplFile    模板 html 绝对路径（可与 tpl 不同名，如 gachaLog/allLog.html）
 * @param {string} [opts.saveId]   产物文件名，默认取 tpl
 * @param {number} [opts.baseScale] 模板基准倍率，默认 1
 * @param {string} [opts.ppath]    资源前缀，默认按 plugin 推导
 * @param {'png'|'jpeg'|'webp'} [opts.imgType] **渲染器**出图类型，默认 png。
 *        这里**不要**传配置项 —— 想改发出去的格式改配置 `img_type`，
 *        这个参数只留给「必须让渲染器直接出某种格式」的特殊场景。
 * @param {string} [opts.format]    出图格式 jpeg/png/webp，默认读配置（不传就跟随锅巴那一项）
 * @param {number} [opts.webpQuality]   webp 质量，默认 82；传 false 跳过压缩（只出 png）
 * @param {'quote'|'forward'|false} [opts.reply] 回复方式；false 时只返回 buffer 不发送
 * @returns {Promise<any|Buffer|false>} reply=false 返回图片 buffer；否则返回 e.reply 结果；失败 false
 */
export async function renderTpl(e, {
  tpl,
  data = {},
  plugin = PLUGIN,
  tplFile,
  saveId,
  baseScale = 1,
  ppath,
  imgType = 'png',
  format,
  webpQuality = 82,
  reply = 'quote',
  rem = false,
} = {}) {
  if (!e?.runtime?.render) {
    logger?.error?.(`[${PLUGIN}][出图] e.runtime.render 不可用（${tpl}）`)
    if (reply !== false) e?.reply?.('出图服务不可用，请稍后重试')
    return false
  }

  const cfg = config()
  const scalePx = getRenderScaleValue(cfg, baseScale)
  const scaleStyle = getRenderScaleStyle(cfg, baseScale)
  const resPath = ppath || resPrefix(plugin)

  // 目标格式：显式传的优先，否则读「输出图片类型」配置
  const target = format || getImageFormat()
  // 老调用点习惯用 webpQuality:false 表示「别压、就出 png」，保持这个语义
  const outFormat = webpQuality === false ? 'png' : target
  // 渲染器那一步固定出无损 png，交给下面 encodeImage 编成目标格式。
  //
  // ⚠️ 只有 sharp 不在、必须让渲染器直接出目标格式时才传别的值，而且**只传 jpeg**：
  // 各家渲染后端对 imgType 的支持面不一样 —— JiuLi 的 puppeteer 后端把它原样透传给
  // page.screenshot（注释声称只支持 jpeg/png），TRSS 的 shotium 后端则对**自身配置项**
  // 做 jpeg/png/webp 白名单校验。取交集、并且只挑最保守的那个，就是 jpeg。
  // 代价是「sharp 缺失 + 用户选了 webp」时实际发出 jpeg（体积大一点），
  // 但总比给渲染器喂一个它可能不认的值、整张图发不出去强。
  const canEncode = await hasSharp()
  const renderAs = (canEncode || outFormat === 'png') ? 'png' : 'jpeg'

  try {
    const result = await e.runtime.render(plugin, tpl, data, {
      retType: 'base64',
      imgType: renderAs,
      beforeRender({ data: d }) {
        return {
          ...d,
          imgType: renderAs,
          scalePx,
          // rem 模板：置空，避免 defaultLayout 在 rem 之上再叠一层 transform（双重缩放）
          // transform 模板：注入 `style=transform:scale(x)`
          sys: { ...(d.sys || {}), scale: rem ? '' : scaleStyle },
          ppath: d.ppath || resPath,
          tplFile: tplFile || d.tplFile,
          saveId: saveId || d.saveId || tpl,
        }
      },
    })

    const raw = extractRenderBuffer(result)
    // 渲染器已经出的就是目标格式（sharp 缺失那条路）时不必再编一遍，
    // 否则等于拿同一张图反复有损编码
    const buffer = renderAs === outFormat
      ? raw
      : await encodeImage(raw, { imgType: outFormat, quality: webpQuality })
    if (!buffer) throw new Error('渲染结果中没有图片数据')

    if (reply === false) return buffer
    const img = segment.image(buffer)
    return reply === 'forward' ? replyForward(e, img) : replyQuote(e, img)
  } catch (err) {
    logger?.error?.(`[${PLUGIN}][出图] 渲染失败（${tpl}）:`, err)
    if (reply !== false) e.reply('渲染失败，请稍后重试')
    return false
  }
}

export default renderTpl
