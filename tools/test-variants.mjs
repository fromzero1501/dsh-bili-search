// 检索词变体切分的最小回归：不联网，只测 queryVariants 与关键词切片的边界
import { queryVariants, keywordParts } from '../lib/core.js'

let fail = 0
function check(name, ok, extra) {
  if (ok) console.log('✅ ' + name)
  else {
    console.log('❌ ' + name + (extra ? ' → ' + extra : ''))
    fail += 1
  }
}

const v1 = queryVariants('AI视频 价格|即梦 价格\nSeedance 套餐｜AI会员 多少钱')
check('按 | 换行 ｜ 切成 4 条', v1.length === 4, JSON.stringify(v1))
check('第一条保留原样', v1[0] === 'AI视频 价格', v1[0])
check('去重同一词', queryVariants('a|A|a ').length === 1, JSON.stringify(queryVariants('a|A|a ')))
check('超过 4 条截断', queryVariants('1|2|3|4|5|6').length === 4)
check('空串给空数组', queryVariants('  ').length === 0)
check('分号也切', queryVariants('价格;套餐').length === 2)

const parts = keywordParts('AI视频 价格|即梦 价格')
check('切片覆盖多个变体（≥4 片）', parts.length >= 4, JSON.stringify(parts))
check('切片不含分隔符', !parts.some((p) => /[|｜]/.test(p)), JSON.stringify(parts))

if (fail) {
  console.log('变体回归失败 ' + fail + ' 项')
  process.exit(1)
}
console.log('变体回归通过')
