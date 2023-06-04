import { compactToken, flattenToken, generateTransforms, generateTree, rules } from './parser/parser'
import { followTokens, transformFirstTokens } from './parser/locate-token'
import { generateParsingTable } from './parser/table'
import { tokenize } from './lexer/lexer'

const transforms = [...rules.values()].flatMap(r => r.branches.map(b => ({ name: r.name, branch: b })))
console.table(transforms.map(t => [t.name, transformFirstTokens(t), followTokens(t.name)]))

console.table([...generateParsingTable().entries()].map(([k, v]) => ({ k, ...Object.fromEntries([...v.entries()].map(([k, t]) => [k, t.branch])) })))

const code = `\
let main = (): Unit {
}`
const tokens = tokenize(code)
console.dir({ tokens }, { depth: null, colors: true })
const chain = generateTransforms(tokens)
console.dir({ chain }, { depth: null, colors: true })
const token = flattenToken(generateTree(tokens, chain)!)
console.dir({ rule: token }, { depth: null, colors: true })
const compact = compactToken(token)
console.dir({ compact }, { depth: null, colors: true })
